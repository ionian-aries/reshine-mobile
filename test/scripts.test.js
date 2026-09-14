import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { prepareProject } from '../docker/prepare-project.js';
import { exportMetadata } from '../docker/export-metadata.js';
import { validateApkConfig, validateDockerOutput, createDockerRunArgs } from '../scripts/build-apk.js';
import { assertSafePath } from '../scripts/utils/config.js';
import { parseManifest } from '../scripts/utils/manifest.js';
import { parseSingleTarget } from '../scripts/utils/targets.js';
import { createDockerBuildArgs } from '../scripts/build-image.js';

test('单目标参数只接受 --target', () => {
  assert.equal(parseSingleTarget(['--target', 'online'], ['online', 'local']), 'online');
  assert.throws(() => parseSingleTarget(['--targets', 'online'], ['online']), /仅支持参数 --target/);
  assert.throws(() => parseSingleTarget(['--target', 'missing'], ['online']), /未知项目/);
});

test('镜像构建参数使用配置中的唯一镜像引用', () => {
  assert.deepEqual(createDockerBuildArgs('android-builder:5.24.2026081301-r2'), [
    'build', '--platform', 'linux/amd64', '--tag', 'android-builder:5.24.2026081301-r2', '.'
  ]);
  assert.throws(() => createDockerBuildArgs('  '), /apk.image/);
});

test('APK 容器参数固定平台、断网并只读挂载输入', () => {
  const args = createDockerRunArgs('builder:test', '/safe/input', '/safe/output');
  assert.ok(args.includes('--platform=linux/amd64'));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('type=bind,src=/safe/input,dst=/input,readonly'));
  assert.ok(args.includes('type=bind,src=/safe/output,dst=/output'));
  assert.deepEqual(args.slice(-1), ['builder:test']);
});

test('JSONC 注释不会破坏字符串且校验顶层版本', () => {
  const content = `{// comment\n"appid":"__UNI__ABC123","versionName":"1.2.3","versionCode":"4","nested":{"versionName":"9.9.9"},"url":"https://a/b"}`;
  const parsed = parseManifest(content);
  assert.equal(parsed.value.url, 'https://a/b');
  assert.deepEqual(parsed, {
    value: { appid: '__UNI__ABC123', versionName: '1.2.3', versionCode: '4', nested: { versionName: '9.9.9' }, url: 'https://a/b' },
    appId: '__UNI__ABC123', versionName: '1.2.3', versionCode: '4', versionCodeNumber: 4
  });
});

test('APK 配置校验拒绝无效字段值', () => {
  const config = {
    template: { hbuilderxVersion: '5.24.2026081301' },
    uniapp: { name: '在线版', appid: '__UNI__ABC123', versionCode: 1, versionName: '1.0.0' },
    android: {
      namespace: 'com.example.online', appName: '在线版', applicationId: 'com.example.online', dcloudAppKey: 'secret',
      signing: { storeFile: 'secrets/custom.keystore', keyAlias: 'release', keyPassword: 'secret', storePassword: 'secret' }
    }
  };
  assert.equal(validateApkConfig(structuredClone(config)).uniapp.versionCode, 1);
  assert.throws(() => validateApkConfig({ ...config, template: { hbuilderxVersion: 'other' } }), /hbuilderxVersion/);
  assert.throws(() => validateApkConfig({ ...config, android: { ...config.android, namespace: 'invalid' } }), /namespace/);
  assert.throws(() => validateApkConfig({ ...config, android: { ...config.android, signing: { ...config.android.signing, storeFile: '../outside.keystore' } } }), /相对路径|无效路径段/);
});

test('官方 simpleDemo 临时副本可注入业务配置并拒绝符号链接资源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reshine-injection-'));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const template = path.join(projectRoot, 'android-project');
  const project = path.join(root, 'project');
  const input = path.join(root, 'input');
  await mkdir(path.join(input, 'resources/apps/__UNI__ABC123/www'), { recursive: true });
  await mkdir(path.join(input, 'secrets'), { recursive: true });
  const config = {
    template: { hbuilderxVersion: '5.24.2026081301' },
    uniapp: { name: 'fixture', appid: '__UNI__ABC123', versionName: '1.2.3', versionCode: 7 },
    android: {
      namespace: 'com.example.fixture', appName: '测试应用', applicationId: 'com.example.fixture', dcloudAppKey: 'app-key',
      signing: { storeFile: 'secrets/custom-name.keystore', storePassword: 'secret', keyAlias: 'release', keyPassword: 'secret' }
    }
  };
  await writeFile(path.join(input, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(input, 'resources/apps/__UNI__ABC123/www/manifest.json'), JSON.stringify({ id: '__UNI__ABC123', version: { name: '1.2.3', code: '7' } }));
  await writeFile(path.join(input, 'secrets/custom-name.keystore'), 'certificate');
  try {
    await chmod(path.join(template, 'gradlew'), 0o755);
    await prepareProject(template, input, project);
    const gradlewInfo = await stat(path.join(project, 'gradlew'));
    assert.notEqual(gradlewInfo.mode & 0o111, 0);
    assert.equal(await readFile(path.join(project, 'simpleDemo/release.keystore'), 'utf8'), 'certificate');
    const gradle = await readFile(path.join(project, 'simpleDemo/build.gradle'), 'utf8');
    assert.match(gradle, /namespace 'com\.example\.fixture'/);
    assert.match(gradle, /applicationId 'com\.example\.fixture'/);
    assert.match(gradle, /storeFile file\('release\.keystore'\)/);

    const badProject = path.join(root, 'bad-project');
    await rm(path.join(input, 'resources/apps/__UNI__ABC123/www/manifest.json'));
    await writeFile(path.join(root, 'outside.json'), JSON.stringify({ id: '__UNI__ABC123' }));
    await symlink(path.join(root, 'outside.json'), path.join(input, 'resources/apps/__UNI__ABC123/www/manifest.json'));
    await assert.rejects(prepareProject(template, input, badProject), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('APK 元数据导出不包含敏感值', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reshine-metadata-'));
  const configPath = path.join(root, 'config.json');
  const apkPath = path.join(root, 'input.apk');
  const outputPath = path.join(root, 'metadata.json');
  const config = { template: { hbuilderxVersion: '5.24.2026081301', image: 'builder:test' }, uniapp: { name: 'fixture', appid: '__UNI__ABC123', versionName: '1.2.3', versionCode: 7 }, android: { namespace: 'com.example.fixture', applicationId: 'com.example.fixture', dcloudAppKey: 'do-not-export', signing: { storePassword: 'do-not-export' } } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(apkPath, 'apk');
  try {
    const metadata = await exportMetadata(configPath, apkPath, outputPath, 'a'.repeat(64), 'builder:test');
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.apk.size, 3);
    const output = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(output, /do-not-export/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Docker 输出校验要求 APK、摘要、元数据和 COMPLETE 一致', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'reshine-output-'));
  const apkName = 'fixture-1.2.3-7.apk';
  const apk = Buffer.from('apk');
  const digest = (await import('node:crypto')).createHash('sha256').update(apk).digest('hex');
  const config = { template: { hbuilderxVersion: '5.24.2026081301', image: 'builder:test' }, android: { namespace: 'com.example.fixture', applicationId: 'com.example.fixture' } };
  const manifest = { appId: '__UNI__ABC123', versionName: '1.2.3', versionCodeNumber: 7 };
  await writeFile(path.join(output, apkName), apk);
  await writeFile(path.join(output, `${apkName}.sha256`), `${digest}  ${apkName}\n`);
  await writeFile(path.join(output, 'COMPLETE'), `${digest}\n`);
  await writeFile(path.join(output, 'build-metadata.json'), JSON.stringify({ result: 'success', app: { appid: manifest.appId, applicationId: config.android.applicationId, namespace: config.android.namespace, versionName: manifest.versionName, versionCode: manifest.versionCodeNumber }, template: config.template, apk: { fileName: apkName, sha256: digest, size: apk.length }, signing: { certificateSha256: 'a'.repeat(64) } }));
  try {
    assert.equal(await validateDockerOutput(output, config, manifest), path.join(output, apkName));
    await writeFile(path.join(output, 'COMPLETE'), 'invalid\n');
    await assert.rejects(validateDockerOutput(output, config, manifest), /COMPLETE/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('路径安全检查拒绝符号链接逃逸', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'reshine-outside-'));
  const fixture = path.join(projectRoot, '.path-safety-test');
  await mkdir(fixture, { recursive: true });
  const link = path.join(fixture, 'outside');
  await symlink(outside, link);
  try { await assert.rejects(assertSafePath(path.join(link, 'output'), { fieldName: '测试路径', allowMissing: true }), /符号链接/); }
  finally { const { rm } = await import('node:fs/promises'); await rm(fixture, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
