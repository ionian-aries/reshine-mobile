import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAppPlus } from './build-app-plus.js';
import { assertSafePath, normalizeError, readBuildConfig, resolveProjectPath, resolveUniappTarget } from './utils/config.js';
import { parseManifest } from './utils/manifest.js';
import { runCommand } from './utils/process.js';
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
async function copyOptionalDirectory(source, target) {
  const info = await lstat(source).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${source} 必须是非符号链接目录`);
  await assertSafePath(source, { fieldName: source });
  await cp(source, target, { recursive: true });
}
export async function validateDockerOutput(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  if (entries.some((item) => !item.isFile())) throw new Error('Docker 输出目录只能包含普通文件');
  const apks = entries.filter((item) => item.name.endsWith('.apk'));
  if (entries.length !== 1 || apks.length !== 1) throw new Error(`Docker 输出目录必须且只能包含 1 个 APK，实际内容：${entries.map((item) => item.name).join(', ') || '空'}`);
  const apkPath = path.join(outputDir, apks[0].name);
  const info = await stat(apkPath);
  if (info.size === 0) throw new Error('Docker 输出 APK 为空');
  return apkPath;
}
export function createDockerRunArgs(image, inputDir, outputDir) {
  const imageName = requireString(image, 'apk.image');
  return ['run', '--rm', '--platform=linux/amd64', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--env', `ANDROID_BUILDER_IMAGE=${imageName}`, '--mount', `type=bind,src=${inputDir},dst=/input,readonly`, '--mount', `type=bind,src=${outputDir},dst=/output`, imageName];
}
export async function runDockerBuild(image, inputDir, outputDir) {
  await runCommand('docker', createDockerRunArgs(image, inputDir, outputDir), { label: 'Docker Android APK 构建' });
}
async function main() {
  const { apk, targets, availableNames } = await readBuildConfig();
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  const targetConfig = targets[name];
  const target = await resolveUniappTarget(name, targetConfig);
  const sourceInput = await resolveProjectPath(targetConfig?.apk?.inputDir, `${name}.apk.inputDir`);
  const output = await resolveProjectPath(targetConfig?.output?.apkDir, `${name}.output.apkDir`, { allowMissing: true });
  const sourceConfig = await readApkConfig(path.join(sourceInput.absolutePath, 'config.json'));
  const sourceManifest = parseManifest(await readFile(path.join(target.dir, 'src', 'manifest.json'), 'utf8'));
  if (sourceConfig.uniapp.appid !== sourceManifest.appId || sourceConfig.uniapp.name !== sourceManifest.value.name) throw new Error('config.json 与 UniApp manifest 身份不一致');
  const { appPlusDir, manifest } = await buildAppPlus(target, targetConfig);
  const runtimeConfig = structuredClone(sourceConfig);
  runtimeConfig.uniapp.versionName = manifest.versionName;
  runtimeConfig.uniapp.versionCode = manifest.versionCodeNumber;
  runtimeConfig.template.image = requireString(apk?.image, 'apk.image');
  await mkdir(output.absolutePath, { recursive: true });
  await rm(output.absolutePath, { recursive: true, force: true });
  await mkdir(output.absolutePath, { recursive: true });
  const runRoot = await mkdtemp(path.join(process.cwd(), `.apk-build-${name}-`));
  const input = path.join(runRoot, 'input');
  try {
    await mkdir(path.join(input, 'resources', 'apps', manifest.appId, 'www'), { recursive: true });
    await writeFile(path.join(input, 'config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`, { mode: 0o600 });
    await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'override'), path.join(input, 'override'));
    await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'secrets'), path.join(input, 'secrets'));
    await cp(appPlusDir, path.join(input, 'resources', 'apps', manifest.appId, 'www'), { recursive: true });
    await assertSafePath(path.join(sourceInput.absolutePath, sourceConfig.android.signing.storeFile), { fieldName: `${name} keystore` });
    await runDockerBuild(apk?.image, input, output.absolutePath);
    const apkPath = await validateDockerOutput(output.absolutePath);
    console.log(`[build:apk] ${name} APK 构建成功`);
    console.log(apkPath);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`[build:apk] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });