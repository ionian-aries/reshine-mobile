import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAppPlus } from './build-app-plus.js';
import { assertSafePath, normalizeError, readBuildConfig, resolveProjectPath, resolveUniappTarget } from './utils/config.js';
import { parseManifest } from './utils/manifest.js';
import { runCommand } from './utils/process.js';
import { createStageTimer } from './utils/timing.js';
import { chooseSingleTarget } from './utils/targets.js';

const TEMPLATE_VERSION = '5.24.2026081301';
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const OVERRIDE_PATTERNS = [
  /^simpleDemo\/src\/main\/res\/drawable(?:-[a-z0-9-]+)?\/(?:icon|push|splash)\.(?:png|webp)$/,
  /^simpleDemo\/src\/main\/res\/mipmap(?:-[a-z0-9-]+)?\/ic_launcher(?:_round)?\.(?:png|webp)$/,
  /^simpleDemo\/src\/main\/res\/values\/(?:colors|styles)\.xml$/
];
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
async function listOverrideFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`override 不允许符号链接：${child}`);
    if (info.isDirectory()) files.push(...await listOverrideFiles(root, child));
    else if (info.isFile()) files.push(child.split(path.sep).join('/'));
    else throw new Error(`override 不允许特殊文件：${child}`);
  }
  return files;
}
export async function validateApkStaticInputs(sourceInput, config) {
  const keystore = path.join(sourceInput, ...config.android.signing.storeFile.split('/'));
  await assertSafePath(keystore, { fieldName: 'keystore' });
  const keyInfo = await lstat(keystore);
  if (!keyInfo.isFile()) throw new Error('keystore 必须是普通文件');
  const override = path.join(sourceInput, 'override');
  const overrideInfo = await lstat(override).catch(() => null);
  if (!overrideInfo) return;
  if (overrideInfo.isSymbolicLink() || !overrideInfo.isDirectory()) throw new Error('override 必须是非符号链接目录');
  for (const relative of await listOverrideFiles(override)) {
    if (!OVERRIDE_PATTERNS.some((pattern) => pattern.test(relative))) throw new Error(`override 文件不在白名单：${relative}`);
  }
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
function requireDockerMountPath(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} 必须是非空字符串`);
  if (value.includes(',')) throw new Error(`${name} 不能包含逗号：Docker --mount 无法安全解析该路径`);
  return value;
}
export function createDockerRunArgs(image, inputDir, outputDir) {
  const imageName = requireString(image, 'apk.image');
  const inputPath = requireDockerMountPath(inputDir, 'Docker 输入路径');
  const outputPath = requireDockerMountPath(outputDir, 'Docker 输出路径');
  return ['run', '--rm', '--platform=linux/amd64', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--env', `ANDROID_BUILDER_IMAGE=${imageName}`, '--mount', `type=bind,src=${inputPath},dst=/input,readonly`, '--mount', `type=bind,src=${outputPath},dst=/output`, imageName];
}
export async function runDockerBuild(image, inputDir, outputDir) {
  await runCommand('docker', createDockerRunArgs(image, inputDir, outputDir), { label: 'Docker Android APK 构建' });
}
async function main(timer) {
  const context = await timer.stage('读取配置与静态校验', async () => {
    const { apk, targets, availableNames } = await readBuildConfig();
    const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
    const targetConfig = targets[name];
    const target = await resolveUniappTarget(name, targetConfig);
    const sourceInput = await resolveProjectPath(targetConfig?.apk?.inputDir, `${name}.apk.inputDir`);
    const output = await resolveProjectPath(targetConfig?.output?.apkDir, `${name}.output.apkDir`, { allowMissing: true });
    const sourceConfig = await readApkConfig(path.join(sourceInput.absolutePath, 'config.json'));
    const sourceManifest = parseManifest(await readFile(path.join(target.dir, 'src', 'manifest.json'), 'utf8'));
    if (sourceConfig.uniapp.appid !== sourceManifest.appId || sourceConfig.uniapp.name !== sourceManifest.value.name) throw new Error('config.json 与 UniApp manifest 身份不一致');
    requireString(apk?.image, 'apk.image');
    await validateApkStaticInputs(sourceInput.absolutePath, sourceConfig);
    return { apk, name, targetConfig, target, sourceInput, output, sourceConfig };
  });
  const { apk, name, targetConfig, target, sourceInput, output, sourceConfig } = context;
  const { appPlusDir, manifest } = await timer.stage('构建 App-plus 资源', () => buildAppPlus(target, targetConfig));
  const runtimeConfig = structuredClone(sourceConfig);
  runtimeConfig.uniapp.versionName = manifest.versionName;
  runtimeConfig.uniapp.versionCode = manifest.versionCodeNumber;
  runtimeConfig.template.image = requireString(apk?.image, 'apk.image');
  const runRoot = await mkdtemp(path.join(process.cwd(), `.apk-build-${name}-`));
  const input = path.join(runRoot, 'input');
  try {
    await timer.stage('准备容器输入', async () => {
      await rm(output.absolutePath, { recursive: true, force: true });
      await mkdir(output.absolutePath, { recursive: true });
      await mkdir(path.join(input, 'resources', 'apps', manifest.appId, 'www'), { recursive: true });
      await writeFile(path.join(input, 'config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`, { mode: 0o600 });
      await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'override'), path.join(input, 'override'));
      await copyOptionalDirectory(path.join(sourceInput.absolutePath, 'secrets'), path.join(input, 'secrets'));
      await cp(appPlusDir, path.join(input, 'resources', 'apps', manifest.appId, 'www'), { recursive: true });
    });
    await timer.stage('容器内 Android 构建', () => runDockerBuild(apk?.image, input, output.absolutePath));
    const apkPath = await timer.stage('校验 APK 输出', () => validateDockerOutput(output.absolutePath));
    console.log(`[build:apk] ${name} APK 构建成功`);
    console.log(apkPath);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const timer = createStageTimer('build:apk');
  main(timer).then(() => timer.finish(true)).catch((error) => { console.error(`[build:apk] 构建失败：${normalizeError(error).message}`); timer.finish(false); process.exitCode = 1; });
}