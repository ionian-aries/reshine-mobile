import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { prepareProject } from '../docker/prepare-project.js';
import { validateApkConfig, validateApkStaticInputs, validateDockerOutput, createDockerRunArgs } from '../scripts/build-apk.js';
import { assertSafePath } from '../scripts/utils/config.js';
import { parseManifest } from '../scripts/utils/manifest.js';
import { parseSingleTarget } from '../scripts/utils/targets.js';
import { createDockerBuildArgs } from '../scripts/build-image.js';
import { applyLocalSourcePatches, parseEnv, validateLocalApiBaseUrl, validateLocalDistIndex } from '../scripts/build-local-assets.js';
import { validateAppPlusOutput } from '../scripts/build-app-plus.js';
import { createStageTimer } from '../scripts/utils/timing.js';
import { calculateVersion } from '../scripts/update-version.js';

test('单目标参数只接受 --target', () => {
  assert.equal(parseSingleTarget(['--target', 'online'], ['online', 'local']), 'online');
  assert.throws(() => parseSingleTarget(['--targets', 'online'], ['online']), /仅支持参数 --target/);
  assert.throws(() => parseSingleTarget(['--target', 'missing'], ['online']), /未知项目/);
});

test('分阶段计时在失败时输出阶段和总耗时', async () => {
  const logs = [];
  let now = 1000;
  const timer = createStageTimer('fixture', { now: () => now, log: (line) => logs.push(line) });
  await assert.rejects(timer.stage('失败阶段', async () => { now = 2500; throw new Error('boom'); }), /boom/);
  now = 3000;
  timer.finish(false);
  assert.deepEqual(logs, [
    '[fixture] 阶段开始：失败阶段',
    '[fixture] 阶段失败：失败阶段（1.5 s）',
    '[fixture] 总耗时：2.0 s（失败）'
  ]);
});

test('版本升级支持 patch、minor 和 major 且 versionCode 始终加一', () => {
  const current = { parts: [1, 4, 7], versionCode: 108 };
  assert.deepEqual(calculateVersion(current, 'patch'), { versionName: '1.4.8', versionCode: 109, versionCodeText: '109' });
  assert.deepEqual(calculateVersion(current, 'minor'), { versionName: '1.5.0', versionCode: 109, versionCodeText: '109' });
  assert.deepEqual(calculateVersion(current, 'major'), { versionName: '2.0.0', versionCode: 109, versionCodeText: '109' });
  assert.throws(() => calculateVersion(current, 'unknown'), /未知版本升级级别/);
});

test('版本升级拒绝语义版本段溢出', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.throws(() => calculateVersion({ parts: [1, 2, max], versionCode: 1 }, 'patch'), /patch/);
  assert.throws(() => calculateVersion({ parts: [1, max, 2], versionCode: 1 }, 'minor'), /minor/);
  assert.throws(() => calculateVersion({ parts: [max, 2, 3], versionCode: 1 }, 'major'), /major/);
});

test('镜像构建参数使用配置中的唯一镜像引用', () => {
  assert.deepEqual(createDockerBuildArgs('android-builder:5.24.2026081301-r2'), [
    'build', '--platform', 'linux/amd64', '--tag', 'android-builder:5.24.2026081301-r2', '.'
  ]);
  assert.throws(() => createDockerBuildArgs('  '), /apk.image/);
});

test('APK 容器参数直接传递 macOS 中文空格路径且不含字面引号', () => {
  const input = '/Users/测试用户/构建 输入';
  const output = '/Users/测试用户/构建 输出';
  const args = createDockerRunArgs('builder:test', input, output);
  assert.ok(args.includes('--platform=linux/amd64'));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes(`type=bind,src=${input},dst=/input,readonly`));
  assert.ok(args.includes(`type=bind,src=${output},dst=/output`));
  assert.ok(args.filter((arg) => arg.startsWith('type=bind,')).every((arg) => !arg.includes('"')));
  assert.deepEqual(args.slice(-1), ['builder:test']);
});

test('APK 容器参数直接传递 Windows 盘符、空格和中文路径', () => {
  const input = 'C:\\项目 文件\\构建输入';
  const output = 'D:\\发布目录\\构建 输出';
  const args = createDockerRunArgs('builder:test', input, output);
  assert.ok(args.includes(`type=bind,src=${input},dst=/input,readonly`));
  assert.ok(args.includes(`type=bind,src=${output},dst=/output`));
});

test('APK 容器参数在启动 Docker 前拒绝含逗号路径', () => {
  assert.throws(() => createDockerRunArgs('builder:test', '/safe/in,put', '/safe/output'), /输入路径.*逗号/);
  assert.throws(() => createDockerRunArgs('builder:test', '/safe/input', 'C:\\输出,目录'), /输出路径.*逗号/);
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

test('APK 和 WGT 产物名使用 versionName 且不包含 versionCode', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entrypoint = await readFile(path.join(projectRoot, 'docker/entrypoint.sh'), 'utf8');
  const buildWgt = await readFile(path.join(projectRoot, 'scripts/build-wgt.js'), 'utf8');
  assert.match(entrypoint, /name\+'-v'\+version\+'\.apk'/);
  assert.doesNotMatch(entrypoint, /versionCode\+'\.apk'/);
  assert.match(buildWgt, /`\$\{manifest\.appId\}-v\$\{manifest\.versionName\}\.wgt`/);
});

test('APK 静态输入在构建前校验 keystore 与 override 白名单', async () => {
  const root = await mkdtemp(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.apk-static-'));
  const config = { android: { signing: { storeFile: 'secrets/release.jks' } } };
  try {
    await mkdir(path.join(root, 'secrets'), { recursive: true });
    await assert.rejects(validateApkStaticInputs(root, config), /keystore.*不存在/);
    await writeFile(path.join(root, 'secrets/release.jks'), 'key');
    await mkdir(path.join(root, 'override/simpleDemo'), { recursive: true });
    await writeFile(path.join(root, 'override/simpleDemo/bad.txt'), 'bad');
    await assert.rejects(validateApkStaticInputs(root, config), /不在白名单/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Docker 输出目录只能保留一个非空 APK', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'reshine-output-'));
  const apkName = 'fixture-v1.2.3.apk';
  const apkPath = path.join(output, apkName);
  await writeFile(apkPath, 'apk');
  try {
    assert.equal(await validateDockerOutput(output), apkPath);
    await writeFile(path.join(output, 'build-metadata.json'), '{}');
    await assert.rejects(validateDockerOutput(output), /只能包含 1 个 APK/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('local 环境变量与源码适配可校验且不修改输入', () => {
  assert.equal(parseEnv('# comment\nVUE_APP_LOCAL_API_BASE_URL=http://192.168.1.10:8080/').VUE_APP_LOCAL_API_BASE_URL, 'http://192.168.1.10:8080/');
  assert.equal(validateLocalApiBaseUrl('http://192.168.1.10:8080/'), 'http://192.168.1.10:8080');
  assert.throws(() => validateLocalApiBaseUrl('file:///tmp'), /HTTP/);
  const original = new Map([
    ['vue.config.js', "module.exports = {\n  lintOnSave: false,\n};\n"],
    ['src/router/init.js', "const router = {\n    mode: window.LcapVueRouterConfig?.mode || 'history',\n};\n"],
    ['src/config.js', "    // 修改请求baseURL\n    // _options.baseURL = 'https://some-domain.com/api';\n"]
  ]);
  const patched = applyLocalSourcePatches(original);
  assert.match(patched.get('vue.config.js'), /publicPath: '\.\/'/);
  assert.match(patched.get('src/router/init.js'), /mode: 'hash'/);
  assert.match(patched.get('src/config.js'), /VUE_APP_LOCAL_API_BASE_URL/);
  assert.doesNotMatch(original.get('vue.config.js'), /publicPath/);
});

test('local H5 入口拒绝根绝对和远程运行时资源', () => {
  assert.deepEqual(validateLocalDistIndex('<script src="js/app.js"></script><link href="css/app.css">'), ['js/app.js', 'css/app.css']);
  assert.throws(() => validateLocalDistIndex('<script src="/js/app.js"></script>'), /根绝对资源/);
  assert.throws(() => validateLocalDistIndex('<script src="https://cdn.example/app.js"></script>'), /远程运行时资源/);
  assert.throws(() => validateLocalDistIndex('<script src="data:text/javascript,alert(1)"></script>'), /资源协议/);
});

test('App-plus 输出必须匹配 App ID 和版本', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'reshine-app-plus-'));
  const manifest = { appId: '__UNI__ABC123', versionName: '1.2.3', versionCode: '7' };
  try {
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ id: manifest.appId, version: { name: manifest.versionName, code: manifest.versionCode } }));
    await validateAppPlusOutput(output, manifest);
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ id: '__UNI__BAD', version: { name: '1.2.3', code: '7' } }));
    await assert.rejects(validateAppPlusOutput(output, manifest), /App ID/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('online App 启用 Bluetooth 模块且 Android 模板只声明业务必需权限', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceManifest = parseManifest(await readFile(path.join(projectRoot, 'online/src/manifest.json'), 'utf8'));
  const localManifest = parseManifest(await readFile(path.join(projectRoot, 'local/src/manifest.json'), 'utf8'));
  assert.deepEqual(sourceManifest.value['app-plus'].modules.Bluetooth, {});
  assert.deepEqual(
    localManifest.value['app-plus'].distribute.android.permissions,
    sourceManifest.value['app-plus'].distribute.android.permissions,
  );
  const sourcePermissions = sourceManifest.value['app-plus'].distribute.android.permissions.join('\n');
  for (const permission of ['INTERNET', 'REQUEST_INSTALL_PACKAGES', 'BLUETOOTH', 'BLUETOOTH_ADMIN', 'BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) {
    assert.match(sourcePermissions, new RegExp(`android\\.permission\\.${permission}`));
  }
  assert.doesNotMatch(sourcePermissions, /android\.permission\.CAMERA/);
  assert.match(sourcePermissions, /android\.permission\.BLUETOOTH" android:maxSdkVersion="30"/);
  assert.match(sourcePermissions, /android\.permission\.BLUETOOTH_ADMIN" android:maxSdkVersion="30"/);
  assert.match(sourcePermissions, /android\.permission\.ACCESS_COARSE_LOCATION" android:maxSdkVersion="28"/);
  assert.match(sourcePermissions, /android\.permission\.ACCESS_FINE_LOCATION"\/>/);
  assert.doesNotMatch(sourcePermissions, /ACCESS_FINE_LOCATION[^\n]*maxSdkVersion/);
  assert.doesNotMatch(sourcePermissions, /neverForLocation/);
  assert.match(sourcePermissions, /android\.hardware\.bluetooth_le/);

  const manifest = await readFile(path.join(projectRoot, 'android-project/simpleDemo/src/main/AndroidManifest.xml'), 'utf8');
  for (const permission of ['INTERNET', 'REQUEST_INSTALL_PACKAGES', 'BLUETOOTH', 'BLUETOOTH_ADMIN', 'BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`));
  }
  for (const permission of ['CAMERA', 'RECORD_AUDIO', 'VIBRATE', 'WAKE_LOCK', 'ACCESS_WIFI_STATE', 'CHANGE_NETWORK_STATE', 'CHANGE_WIFI_STATE', 'FLASHLIGHT']) {
    assert.doesNotMatch(manifest, new RegExp(`android\\.permission\\.${permission}(?:"|\\s)`));
  }
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION" android:maxSdkVersion="28"/);
  assert.match(manifest, /android\.permission\.BLUETOOTH" android:maxSdkVersion="30"/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_ADMIN" android:maxSdkVersion="30"/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION" \/>/);
  assert.doesNotMatch(manifest, /android\.permission\.ACCESS_FINE_LOCATION" android:maxSdkVersion/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN" \/>/);
  assert.doesNotMatch(manifest, /neverForLocation/);
  assert.match(manifest, /android\.hardware\.bluetooth_le" android:required="false"/);
  assert.doesNotMatch(manifest, /android\.hardware\.camera/);
  for (const permission of ['ACCESS_NETWORK_STATE', 'WRITE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_VISUAL_USER_SELECTED']) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${permission}" tools:node="remove"`));
  }
  assert.match(manifest, /usesCleartextTraffic="true"/);
});
test('BLE 权限、错误归一化与会话权限复核在 local/online 保持一致', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const relativeFiles = [
    'src/uni_modules/app-ble-manager/js_sdk/platform/uni-permissions.js',
    'src/uni_modules/app-ble-manager/js_sdk/errors/normalize.js',
    'src/uni_modules/app-ble-manager/js_sdk/core/ble-manager.js',
  ];
  for (const relativeFile of relativeFiles) {
    const localSource = await readFile(path.join(projectRoot, 'local', relativeFile), 'utf8');
    const onlineSource = await readFile(path.join(projectRoot, 'online', relativeFile), 'utf8');
    assert.equal(localSource, onlineSource, `${relativeFile} 应在 local/online 保持一致`);
  }

  const permissions = await readFile(path.join(projectRoot, 'online', relativeFiles[0]), 'utf8');
  assert.match(permissions, /apiLevel >= 31[\s\S]*BLUETOOTH_SCAN[\s\S]*BLUETOOTH_CONNECT[\s\S]*ACCESS_FINE_LOCATION/);
  assert.match(permissions, /:\s*\['android\.permission\.ACCESS_FINE_LOCATION'\]/);

  const normalize = await readFile(path.join(projectRoot, 'online', relativeFiles[1]), 'utf8');
  assert.match(normalize, /permissionDenied\s*=\s*\/permission/);
  assert.match(normalize, /permissionDenied \? ErrorCodes\.PERMISSION_DENIED[\s\S]*UNI_ERROR_CODES\[nativeCode\]/);
  assert.match(normalize, /securityexception/i);

  const manager = await readFile(path.join(projectRoot, 'online', relativeFiles[2]), 'utf8');
  assert.match(manager, /openAppBleSession\(\)[\s\S]*requestPermissions\(\)[\s\S]*platform\.openAdapter\(\)/);
  assert.match(manager, /requestDisableSystemBluetooth\(options\)[\s\S]*requestPermissions\(\)[\s\S]*systemBluetooth\.requestDisable\(\)/);
  assert.match(manager, /refreshSystemBluetoothState\(\)[\s\S]*PERMISSION_DENIED[\s\S]*throw normalized/);
  assert.match(manager, /refreshAdapterState\(\)[\s\S]*PERMISSION_DENIED[\s\S]*throw normalized/);
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
