#!/usr/bin/env node
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEMPLATE_VERSION = '5.24.2026081301';
const MODULE = 'simpleDemo';
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const APP_ID = /^__UNI__[A-Fa-f0-9]+$/;
const OVERRIDE_PATTERNS = [
  /^simpleDemo\/src\/main\/res\/drawable(?:-[a-z0-9-]+)?\/(?:icon|icon_foreground|push|splash)\.(?:png|webp)$/,
  /^simpleDemo\/src\/main\/res\/drawable-anydpi-v26\/icon\.xml$/,
  /^simpleDemo\/src\/main\/res\/mipmap(?:-[a-z0-9-]+)?\/ic_launcher(?:_round)?\.(?:png|webp)$/,
  /^simpleDemo\/src\/main\/res\/values\/(?:colors|styles)\.xml$/
];

function fail(message) { throw new Error(message); }
function requiredString(value, name, { trim = true } = {}) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} 必须是非空字符串`);
  return trim ? value.trim() : value;
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} 必须是正整数`);
  return String(value);
}
function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function escapeGroovy(value) { return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'"); }
function normalizedRelative(value, name) {
  const normalized = requiredString(value, name).replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) fail(`${name} 必须是输入目录内的相对路径`);
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) fail(`${name} 包含无效路径段`);
  return normalized;
}
function isInside(base, candidate, allowSame = false) {
  const relative = path.relative(base, candidate);
  return (allowSame && relative === '') || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
async function assertContained(base, candidate, name, { allowMissing = false, type } = {}) {
  const baseReal = await realpath(base);
  const resolved = path.resolve(candidate);
  if (!isInside(path.resolve(base), resolved, true)) fail(`${name} 超出允许目录`);
  let existing = resolved;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (!allowMissing && existing !== resolved) fail(`${name} 不存在`);
  const info = await lstat(existing);
  if (info.isSymbolicLink()) fail(`${name} 不允许经过符号链接`);
  const existingReal = await realpath(existing);
  if (!isInside(baseReal, existingReal, true)) fail(`${name} 通过符号链接逃逸允许目录`);
  if (existing === resolved) {
    if (type === 'file' && !info.isFile()) fail(`${name} 必须是文件`);
    if (type === 'directory' && !info.isDirectory()) fail(`${name} 必须是目录`);
  }
  return resolved;
}
async function listFiles(root, relative = '') {
  const directory = await assertContained(root, path.join(root, relative), `目录 ${relative || '.'}`, { type: 'directory' });
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) fail(`不允许符号链接：${child}`);
    if (info.isDirectory()) files.push(...await listFiles(root, child));
    else if (info.isFile()) files.push(child.split(path.sep).join('/'));
    else fail(`不允许特殊文件：${child}`);
  }
  return files;
}
async function chmodTreeWritable(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) fail(`不允许符号链接：${root}`);
  const executable = Boolean(info.mode & 0o111);
  await chmod(root, info.isDirectory() ? 0o755 : executable ? 0o755 : 0o644);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root)) await chmodTreeWritable(path.join(root, entry));
}
function replaceExactly(content, pattern, replacement, name) {
  const matches = content.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) fail(`${name} 必须恰好匹配一次，实际 ${matches.length} 次`);
  return content.replace(pattern, replacement);
}
async function readConfig(inputDir) {
  const configPath = await assertContained(inputDir, path.join(inputDir, 'config.json'), 'config.json', { type: 'file' });
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { fail(`config.json 读取或解析失败：${error.message}`); }
  if (requiredString(config?.template?.hbuilderxVersion, 'template.hbuilderxVersion') !== TEMPLATE_VERSION) fail(`template.hbuilderxVersion 必须为 ${TEMPLATE_VERSION}`);
  const normalized = {
    template: { hbuilderxVersion: TEMPLATE_VERSION },
    uniapp: {
      name: requiredString(config?.uniapp?.name, 'uniapp.name'),
      appid: requiredString(config?.uniapp?.appid, 'uniapp.appid'),
      versionName: requiredString(config?.uniapp?.versionName, 'uniapp.versionName'),
      versionCode: positiveInteger(config?.uniapp?.versionCode, 'uniapp.versionCode')
    },
    android: {
      namespace: requiredString(config?.android?.namespace, 'android.namespace'),
      applicationId: requiredString(config?.android?.applicationId, 'android.applicationId'),
      appName: requiredString(config?.android?.appName, 'android.appName'),
      dcloudAppKey: requiredString(config?.android?.dcloudAppKey, 'android.dcloudAppKey'),
      signing: { ...(config?.android?.signing ?? {}) }
    }
  };
  if (!PACKAGE_NAME.test(normalized.android.namespace)) fail('android.namespace 格式无效');
  if (!PACKAGE_NAME.test(normalized.android.applicationId)) fail('android.applicationId 格式无效');
  if (!APP_ID.test(normalized.uniapp.appid)) fail('uniapp.appid 格式无效');
  return normalized;
}
async function patchGradle(projectDir, inputDir, config) {
  const signing = config.android.signing;
  if (!signing || typeof signing !== 'object' || Array.isArray(signing)) fail('android.signing 必须是对象');
  const storeRelative = normalizedRelative(signing.storeFile, 'android.signing.storeFile');
  if (!storeRelative.startsWith('secrets/')) fail('android.signing.storeFile 必须位于 secrets/ 目录');
  const storeSource = await assertContained(inputDir, path.join(inputDir, ...storeRelative.split('/')), `签名文件 ${storeRelative}`, { type: 'file' });
  const storeName = path.posix.basename(storeRelative);
  if (!/^[A-Za-z0-9._-]+$/.test(storeName)) fail('签名文件名格式无效');
  const moduleDir = path.join(projectDir, MODULE);
  await cp(storeSource, path.join(moduleDir, 'release.keystore'), { force: false, errorOnExist: true });
  const gradlePath = await assertContained(projectDir, path.join(moduleDir, 'build.gradle'), 'simpleDemo/build.gradle', { type: 'file' });
  let content = await readFile(gradlePath, 'utf8');
  const replacements = [
    [/^\s*namespace\s+['"][^'"]+['"]\s*$/m, `    namespace '${escapeGroovy(config.android.namespace)}'`, 'namespace'],
    [/^\s*applicationId\s+['"][^'"]+['"]\s*$/m, `        applicationId '${escapeGroovy(config.android.applicationId)}'`, 'applicationId'],
    [/^\s*versionCode\s+\d+\s*$/m, `        versionCode ${config.uniapp.versionCode}`, 'versionCode'],
    [/^\s*versionName\s+['"][^'"]+['"]\s*$/m, `        versionName '${escapeGroovy(config.uniapp.versionName)}'`, 'versionName'],
    [/^\s*keyAlias\s+['"][^'"]*['"]\s*$/m, `            keyAlias '${escapeGroovy(requiredString(signing.keyAlias, 'android.signing.keyAlias', { trim: false }))}'`, 'keyAlias'],
    [/^\s*keyPassword\s+['"][^'"]*['"]\s*$/m, `            keyPassword '${escapeGroovy(requiredString(signing.keyPassword, 'android.signing.keyPassword', { trim: false }))}'`, 'keyPassword'],
    [/^\s*storeFile\s+file\(['"][^'"]+['"]\)\s*$/m, "            storeFile file('release.keystore')", 'storeFile'],
    [/^\s*storePassword\s+['"][^'"]*['"]\s*$/m, `            storePassword '${escapeGroovy(requiredString(signing.storePassword, 'android.signing.storePassword', { trim: false }))}'`, 'storePassword']
  ];
  for (const [pattern, replacement, name] of replacements) content = replaceExactly(content, pattern, replacement, `build.gradle ${name}`);
  await writeFile(gradlePath, content, { mode: 0o600 });
}
async function patchXml(projectDir, config) {
  const targets = [
    ['simpleDemo/src/main/res/values/strings.xml', /(<string\s+name="app_name">)[\s\S]*?(<\/string>)/, `$1${escapeXml(config.android.appName)}$2`, 'app_name'],
    ['simpleDemo/src/main/assets/data/dcloud_control.xml', /(<app\s+appid=")[^"]*(")/, `$1${escapeXml(config.uniapp.appid)}$2`, 'UniApp App ID'],
    ['simpleDemo/src/main/AndroidManifest.xml', /(<meta-data\s+android:name="dcloud_appkey"\s+android:value=")[^"]*("\s*\/?>)/, `$1${escapeXml(config.android.dcloudAppKey)}$2`, 'DCloud App Key']
  ];
  for (const [relative, pattern, replacement, name] of targets) {
    const file = await assertContained(projectDir, path.join(projectDir, relative), relative, { type: 'file' });
    const content = replaceExactly(await readFile(file, 'utf8'), pattern, replacement, `${relative} ${name}`);
    await writeFile(file, content, 'utf8');
  }
}
async function installResources(projectDir, inputDir, config) {
  const source = await assertContained(inputDir, path.join(inputDir, 'resources', 'apps', config.uniapp.appid), 'App 资源', { type: 'directory' });
  const www = await assertContained(inputDir, path.join(source, 'www'), 'App 资源 www', { type: 'directory' });
  if ((await listFiles(www)).length === 0) fail('App 资源 www 目录为空');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(www, 'manifest.json'), 'utf8')); }
  catch (error) { fail(`App 资源 manifest.json 读取或解析失败：${error.message}`); }
  if (manifest.id !== config.uniapp.appid) fail(`App 资源 App ID 不一致：${manifest.id ?? '未配置'}`);
  if (String(manifest.version?.name ?? '') !== config.uniapp.versionName) fail('App 资源 versionName 不一致');
  if (String(manifest.version?.code ?? '') !== config.uniapp.versionCode) fail('App 资源 versionCode 不一致');
  const appsDir = path.join(projectDir, MODULE, 'src', 'main', 'assets', 'apps');
  await rm(appsDir, { recursive: true, force: true });
  await mkdir(appsDir, { recursive: true });
  await cp(source, path.join(appsDir, config.uniapp.appid), { recursive: true, errorOnExist: true, force: false });
}
async function applyOverrides(projectDir, inputDir) {
  const overrideDir = path.join(inputDir, 'override');
  const info = await lstat(overrideDir).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) fail('override 必须是非符号链接目录');
  for (const relative of await listFiles(overrideDir)) {
    if (!OVERRIDE_PATTERNS.some((pattern) => pattern.test(relative))) fail(`override 文件不在白名单：${relative}`);
    const source = await assertContained(overrideDir, path.join(overrideDir, ...relative.split('/')), `override ${relative}`, { type: 'file' });
    const target = await assertContained(projectDir, path.join(projectDir, ...relative.split('/')), `override 目标 ${relative}`, { allowMissing: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
}
async function prepareProject(templateDir, inputDir, destinationDir) {
  await assertContained(path.dirname(templateDir), templateDir, 'Android 模板', { type: 'directory' });
  await assertContained(path.dirname(inputDir), inputDir, '输入目录', { type: 'directory' });
  const config = await readConfig(inputDir);
  const parent = path.dirname(destinationDir);
  await mkdir(parent, { recursive: true });
  if ((await lstat(destinationDir).catch(() => null))?.isSymbolicLink()) fail('目标工程目录不允许是符号链接');
  if ((await readdir(destinationDir).catch(() => [])).length) fail('目标工程目录必须不存在或为空');
  const temporaryDir = await mkdtemp(path.join(parent, `.${path.basename(destinationDir)}-prepare-`));
  await rm(temporaryDir, { recursive: true, force: true });
  try {
    await cp(templateDir, temporaryDir, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: false, filter: (source) => !path.relative(templateDir, source).split(path.sep).some((part) => part === '.gradle' || part === 'build' || part === '.DS_Store') });
    await chmodTreeWritable(temporaryDir);
    await patchGradle(temporaryDir, inputDir, config);
    await patchXml(temporaryDir, config);
    await installResources(temporaryDir, inputDir, config);
    await applyOverrides(temporaryDir, inputDir);
    await rm(destinationDir, { recursive: true, force: true });
    await rename(temporaryDir, destinationDir);
    return config;
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}
async function main() {
  const [templateArg, inputArg, projectArg] = process.argv.slice(2);
  if (!templateArg || !inputArg || !projectArg) fail('用法：prepare-project.js <templateDir> <inputDir> <projectDir>');
  await prepareProject(path.resolve(templateArg), path.resolve(inputArg), path.resolve(projectArg));
  console.log('Android 工程准备完成');
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`Android 工程准备失败：${error.message}`); process.exitCode = 1; });

export { prepareProject };
