import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeError, readBuildConfig, resolveProjectPath, resolveUniappTarget } from './utils/config.js';
import { runNpm } from './utils/process.js';
import { chooseSingleTarget } from './utils/targets.js';

const REQUIRED_PATCHES = [
  {
    file: 'vue.config.js',
    name: '相对 publicPath',
    pattern: /module\.exports = \{\r?\n/,
    replacement: "module.exports = {\n  publicPath: './',\n"
  },
  {
    file: 'src/router/init.js',
    name: 'Hash Router',
    pattern: /mode: window\.LcapVueRouterConfig\?\.mode \|\| 'history',/,
    replacement: "mode: 'hash',"
  },
  {
    file: 'src/config.js',
    name: '局域网 API 基址',
    pattern: /    \/\/ 修改请求baseURL\r?\n    \/\/ _options\.baseURL = 'https:\/\/some-domain\.com\/api';/,
    replacement: "    // local APK 中的 H5 通过编译期公开配置访问现场局域网后端。\n    _options.baseURL = process.env.VUE_APP_LOCAL_API_BASE_URL;"
  }
];

function isInside(base, candidate, allowSame = false) {
  const relative = path.relative(base, candidate);
  return (allowSame && relative === '') || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function replaceExactly(content, pattern, replacement, name) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const count = [...content.matchAll(new RegExp(pattern.source, flags))].length;
  if (count !== 1) throw new Error(`${name} 适配锚点必须恰好匹配一次，实际 ${count} 次`);
  return content.replace(pattern, replacement);
}

async function assertRegularTree(root, relative = '') {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (relative === '' && entry.name === 'node_modules') continue;
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`本地 H5 源码不允许符号链接：${child}`);
    if (info.isDirectory()) await assertRegularTree(root, child);
    else if (!info.isFile()) throw new Error(`本地 H5 源码不允许特殊文件：${child}`);
  }
}

function parseEnv(content) {
  const values = {};
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`.env 第 ${index + 1} 行格式无效`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function validateLocalApiBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('VUE_APP_LOCAL_API_BASE_URL 必须是非空绝对 URL');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('VUE_APP_LOCAL_API_BASE_URL 必须是有效绝对 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('VUE_APP_LOCAL_API_BASE_URL 只允许不含凭据、查询参数和片段的 HTTP(S) URL');
  return url.toString().replace(/\/$/, '');
}

function applyLocalSourcePatches(files) {
  const patched = new Map(files);
  for (const patch of REQUIRED_PATCHES) {
    const content = patched.get(patch.file);
    if (typeof content !== 'string') throw new Error(`本地 H5 源码缺少适配文件：${patch.file}`);
    patched.set(patch.file, replaceExactly(content, patch.pattern, patch.replacement, patch.name));
  }
  return patched;
}

function validateLocalDistIndex(content) {
  if (!/<(?:script|link)\b/i.test(content)) throw new Error('本地 H5 dist/index.html 未引用任何 JS 或 CSS 资源');
  const references = [...content.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]);
  for (const reference of references) {
    if (/^(?:https?:)?\/\//i.test(reference)) throw new Error(`本地 H5 入口包含远程运行时资源：${reference}`);
    if (reference.startsWith('/') || reference.startsWith('\\')) throw new Error(`本地 H5 入口包含根绝对资源：${reference}`);
    if (/^(?:data|javascript|file|blob):/i.test(reference)) throw new Error(`本地 H5 入口包含不允许的资源协议：${reference}`);
  }
  return references;
}

async function listRelativeFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listRelativeFiles(root, child));
    else files.push(child);
  }
  return files;
}

async function readRequiredEnv(target) {
  const envPath = path.join(target.dir, '.env');
  let content;
  try { content = await readFile(envPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${target.relativeDir}/.env 不存在，请从 .env.example 创建并配置现场局域网地址`);
    throw error;
  }
  return { VUE_APP_LOCAL_API_BASE_URL: validateLocalApiBaseUrl(parseEnv(content).VUE_APP_LOCAL_API_BASE_URL) };
}

async function validateLocalDist(distDir) {
  const info = await stat(distDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error('本地 H5 构建未生成 dist 目录');
  await assertRegularTree(distDir);
  const indexPath = path.join(distDir, 'index.html');
  const index = await readFile(indexPath, 'utf8').catch((error) => { throw new Error(`本地 H5 缺少有效 dist/index.html：${error.message}`); });
  const references = validateLocalDistIndex(index);
  for (const reference of references) {
    const clean = reference.split(/[?#]/, 1)[0];
    if (!clean || clean.startsWith('data:')) continue;
    const resolved = path.resolve(distDir, clean);
    if (!isInside(distDir, resolved)) throw new Error(`本地 H5 资源路径逃逸 dist：${reference}`);
    if (!(await stat(resolved).catch(() => null))?.isFile()) throw new Error(`本地 H5 入口引用的资源不存在：${reference}`);
  }
  for (const file of (await listRelativeFiles(distDir)).filter((name) => /\.(?:html|js|css)$/i.test(name))) {
    const content = await readFile(path.join(distDir, file), 'utf8');
    if (/https?:\/\/[^\s"')]+\/uni\.webview(?:\.min)?\.js/i.test(content)) throw new Error(`本地 H5 制品包含远程 uni.webview 运行时：${file}`);
  }
}

async function resolveLocalAssetsTarget(name, config) {
  if (!config?.localAssets) throw new Error(`项目 ${name} 未配置 localAssets 本地资源构建能力`);
  const target = await resolveUniappTarget(name, config);
  const source = await resolveProjectPath(config.localAssets.sourceDir, `${name}.localAssets.sourceDir`);
  const output = await resolveProjectPath(config.localAssets.outputDir, `${name}.localAssets.outputDir`, { allowMissing: true });
  const expectedOutputRoot = path.join(target.dir, 'src');
  if (!isInside(expectedOutputRoot, output.absolutePath)) throw new Error(`${name}.localAssets.outputDir 必须位于 ${target.relativeDir}/src 内`);
  if (isInside(source.absolutePath, output.absolutePath, true) || isInside(output.absolutePath, source.absolutePath, true)) throw new Error('localAssets 源目录与输出目录不得重叠');
  return { ...target, sourceDir: source.absolutePath, relativeSourceDir: source.relativePath, outputDir: output.absolutePath, relativeOutputDir: output.relativePath };
}

export async function buildLocalAssets(name, config) {
  const target = await resolveLocalAssetsTarget(name, config);
  const packageFile = path.join(target.sourceDir, 'package.json');
  let packageInfo;
  try { packageInfo = JSON.parse(await readFile(packageFile, 'utf8')); }
  catch (error) { throw new Error(`人工准备的 ${target.relativeSourceDir}/package.json 读取或解析失败：${error.message}`); }
  if (typeof packageInfo.scripts?.build !== 'string' || !packageInfo.scripts.build.trim()) throw new Error(`${target.relativeSourceDir}/package.json 缺少 build 脚本`);
  const env = await readRequiredEnv(target);
  await assertRegularTree(target.sourceDir);
  await rm(path.join(target.sourceDir, 'dist'), { recursive: true, force: true });
  await rm(target.outputDir, { recursive: true, force: true });
  const patchFiles = new Map();
  for (const patch of REQUIRED_PATCHES) patchFiles.set(patch.file, await readFile(path.join(target.sourceDir, patch.file), 'utf8'));
  const originalFiles = new Map(patchFiles);
  try {
    for (const [file, content] of applyLocalSourcePatches(patchFiles)) await writeFile(path.join(target.sourceDir, file), content, 'utf8');
    await runNpm(['install', '--no-audit', '--no-fund'], { cwd: target.sourceDir, env: { HUSKY: '0', ...env }, label: 'local H5 依赖安装' });
    await runNpm(['run', 'build'], { cwd: target.sourceDir, env, label: 'local H5 生产构建' });
    const dist = path.join(target.sourceDir, 'dist');
    await validateLocalDist(dist);
    await mkdir(path.dirname(target.outputDir), { recursive: true });
    await cp(dist, target.outputDir, { recursive: true, force: false, errorOnExist: true });
    await validateLocalDist(target.outputDir);
    return target;
  } finally {
    for (const [file, content] of originalFiles) await writeFile(path.join(target.sourceDir, file), content, 'utf8');
  }
}

async function main() {
  const { targets } = await readBuildConfig();
  const availableNames = Object.keys(targets).filter((name) => targets[name]?.localAssets);
  if (!availableNames.length) throw new Error('build.config.json 中没有配置 localAssets 的项目');
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  console.log(`[build:local-assets] 正在准备 ${name} 的内置 H5`);
  const target = await buildLocalAssets(name, targets[name]);
  console.log(`[build:local-assets] ${name} 内置 H5 构建成功`);
  console.log(target.relativeOutputDir);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(`[build:local-assets] 构建失败：${normalizeError(error).message}`);
  process.exitCode = 1;
});

export { applyLocalSourcePatches, parseEnv, validateLocalApiBaseUrl, validateLocalDistIndex };