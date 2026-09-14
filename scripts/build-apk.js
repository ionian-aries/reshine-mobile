import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertSafePath, normalizeError, readBuildConfig, resolveProjectPath, resolveUniappTarget, validateUniappProject } from './utils/config.js';
import { parseManifest } from './utils/manifest.js';
import { runCommand, runNpm } from './utils/process.js';
import { chooseSingleTarget } from './utils/targets.js';

const TEMPLATE_VERSION = '5.24.2026081301';
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`); return value; }
function requireString(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`); return value.trim(); }
function requireInputPath(value, name) {
  const result = requireString(value, name).replaceAll('\\', '/');
  if (path.posix.isAbsolute(result) || /^[A-Za-z]:\//.test(result) || result.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${name} 必须是安全相对路径`);
  if (!result.startsWith('secrets/')) throw new Error(`${name} 必须位于 secrets/`);
  return result;
}
export function validateApkConfig(value) {
  const config = requireObject(value, 'config.json');
  if (requireString(config.template?.hbuilderxVersion, 'template.hbuilderxVersion') !== TEMPLATE_VERSION) throw new Error(`template.hbuilderxVersion 必须为 ${TEMPLATE_VERSION}`);
  const uniapp = requireObject(config.uniapp, 'uniapp');
  uniapp.name = requireString(uniapp.name, 'uniapp.name');
  uniapp.appid = requireString(uniapp.appid, 'uniapp.appid');
  uniapp.versionName = requireString(uniapp.versionName, 'uniapp.versionName');
  if (!Number.isSafeInteger(uniapp.versionCode) || uniapp.versionCode <= 0) throw new Error('uniapp.versionCode 必须是正整数');
  const android = requireObject(config.android, 'android');
  for (const key of ['namespace', 'applicationId', 'appName', 'dcloudAppKey']) android[key] = requireString(android[key], `android.${key}`);
  if (!PACKAGE_NAME_PATTERN.test(android.namespace) || !PACKAGE_NAME_PATTERN.test(android.applicationId)) throw new Error('Android 包名或 namespace 格式无效');
  const signing = requireObject(android.signing, 'android.signing');
  signing.storeFile = requireInputPath(signing.storeFile, 'android.signing.storeFile');
  for (const key of ['storePassword', 'keyAlias', 'keyPassword']) requireString(signing[key], `android.signing.${key}`);
  return config;
}
async function readApkConfig(file) { return validateApkConfig(JSON.parse(await readFile(file, 'utf8'))); }
async function sha256File(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function copyOptionalDirectory(source, target) {
  const info = await stat(source).catch(() => null);
  if (info) { if (!info.isDirectory()) throw new Error(`${source} 必须是目录`); await cp(source, target, { recursive: true }); }
}
async function buildAppPlus(target, manifest, destination) {
  const appPlus = path.join(target.dir, 'dist', 'build', 'app-plus');
  await rm(appPlus, { recursive: true, force: true });
  await runNpm(['run', 'build:app-plus'], { cwd: target.dir, label: 'App-plus 构建' });
  if (!(await stat(appPlus).catch(() => null))?.isDirectory() || !(await readdir(appPlus)).length) throw new Error('App-plus 输出为空');
  const generated = JSON.parse(await readFile(path.join(appPlus, 'manifest.json'), 'utf8'));
  if (generated.id !== manifest.appId || String(generated.version?.name ?? '') !== manifest.versionName || String(generated.version?.code ?? '') !== manifest.versionCode) throw new Error('App-plus 输出身份或版本不一致');
  await mkdir(destination, { recursive: true });
  await cp(appPlus, destination, { recursive: true });
}
export async function validateDockerOutput(outputDir, config, manifest) {
  const files = (await readdir(outputDir, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name).sort();
  const apks = files.filter((name) => name.endsWith('.apk'));
  if (apks.length !== 1) throw new Error(`Docker 输出 APK 数量必须为 1，实际为 ${apks.length}`);
  const apkName = apks[0];
  const expected = ['COMPLETE', 'build-metadata.json', apkName, `${apkName}.sha256`].sort();
  if (files.length !== expected.length || files.some((name, index) => name !== expected[index])) throw new Error(`Docker 输出文件集合无效：${files.join(', ')}`);
  const digest = await sha256File(path.join(outputDir, apkName));
  if ((await readFile(path.join(outputDir, `${apkName}.sha256`), 'utf8')).trim() !== `${digest}  ${apkName}`) throw new Error('APK SHA-256 文件不一致');
  if ((await readFile(path.join(outputDir, 'COMPLETE'), 'utf8')).trim() !== digest) throw new Error('COMPLETE 标记不一致');
  const metadata = JSON.parse(await readFile(path.join(outputDir, 'build-metadata.json'), 'utf8'));
  if (metadata.result !== 'success' || metadata.app?.appid !== manifest.appId || metadata.app?.applicationId !== config.android.applicationId || metadata.app?.namespace !== config.android.namespace || metadata.app?.versionName !== manifest.versionName || metadata.app?.versionCode !== manifest.versionCodeNumber || metadata.template?.hbuilderxVersion !== config.template.hbuilderxVersion || metadata.template?.image !== config.template.image || metadata.apk?.fileName !== apkName || metadata.apk?.sha256 !== digest || metadata.apk?.size !== (await stat(path.join(outputDir, apkName))).size || !/^[a-f0-9]{64}$/.test(metadata.signing?.certificateSha256 ?? '')) throw new Error('Docker 构建元数据不一致');
  return path.join(outputDir, apkName);
}
export function createDockerRunArgs(image, inputDir, outputDir) {
  const imageName = requireString(image, 'apk.image');
  return ['run', '--rm', '--platform=linux/amd64', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--env', `ANDROID_BUILDER_IMAGE=${imageName}`, '--mount', `type=bind,src=${inputDir},dst=/input,readonly`, '--mount', `type=bind,src=${outputDir},dst=/output`, imageName];
}
export async function runDockerBuild(image, inputDir, outputDir) {
  await runCommand('docker', createDockerRunArgs(image, inputDir, outputDir), { label: 'Docker Android APK 构建' });
}
async function removeEmptyDirectory(directory) {
  try {
    await rm(directory, { recursive: false });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY') return;
    if (error.code === 'EISDIR' || error.code === 'EPERM') {
      if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}
async function publishDirectory(stagedOutput, finalOutput) {
  const parent = path.dirname(finalOutput);
  const backup = path.join(parent, `.${path.basename(finalOutput)}-backup-${process.pid}-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  const exists = await stat(finalOutput).catch(() => null);
  try {
    if (exists) await rename(finalOutput, backup);
    await rename(stagedOutput, finalOutput);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await stat(finalOutput).catch(() => null)) && await stat(backup).catch(() => null)) await rename(backup, finalOutput);
    throw error;
  }
}
async function main() {
  const { apk, targets, availableNames } = await readBuildConfig();
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  const targetConfig = targets[name];
  const target = await resolveUniappTarget(name, targetConfig);
  const sourceInput = await resolveProjectPath(targetConfig?.apk?.inputDir, `${name}.apk.inputDir`);
  const output = await resolveProjectPath(targetConfig?.output?.apkDir, `${name}.output.apkDir`, { allowMissing: true });
  const { manifestPath } = await validateUniappProject(target);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const sourceConfig = await readApkConfig(path.join(sourceInput.absolutePath, 'config.json'));
  if (sourceConfig.uniapp.appid !== manifest.appId || sourceConfig.uniapp.name !== manifest.value.name) throw new Error('config.json 与 UniApp manifest 身份不一致');
  const runtimeConfig = structuredClone(sourceConfig);
  runtimeConfig.uniapp.versionName = manifest.versionName;
  runtimeConfig.uniapp.versionCode = manifest.versionCodeNumber;
  runtimeConfig.template.image = requireString(apk?.image, 'apk.image');
  const stagingParent = path.join(path.dirname(output.absolutePath), '.staging');
  await mkdir(stagingParent, { recursive: true });
  const runRoot = await mkdtemp(path.join(stagingParent, `${name}-`));
  const input = path.join(runRoot, 'input');
  const stagedOutput = path.join(runRoot, 'output');
  try {
    await mkdir(path.join(input, 'resources', 'apps', manifest.appId, 'www'), { recursive: true });
    await mkdir(stagedOutput, { recursive: true });
    await writeFile(path.join(input, 'config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`, { mode: 0o600 });
    await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'override'), path.join(input, 'override'));
    await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'secrets'), path.join(input, 'secrets'));
    await buildAppPlus(target, manifest, path.join(input, 'resources', 'apps', manifest.appId, 'www'));
    await assertSafePath(path.join(sourceInput.absolutePath, sourceConfig.android.signing.storeFile), { fieldName: `${name} keystore` });
    await runDockerBuild(apk?.image, input, stagedOutput);
    const stagedApk = await validateDockerOutput(stagedOutput, runtimeConfig, manifest);
    const apkName = path.basename(stagedApk);
    await publishDirectory(stagedOutput, output.absolutePath);
    console.log(`[build:apk] ${name} APK 构建成功`);
    console.log(path.join(output.absolutePath, apkName));
  } finally {
    await rm(runRoot, { recursive: true, force: true });
    await removeEmptyDirectory(stagingParent);
  }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`[build:apk] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });