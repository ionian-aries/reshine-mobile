import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertSafePath, normalizeError, readBuildConfig, resolveUniappTarget, validateUniappProject } from './utils/config.js';
import { buildLocalAssets } from './build-local-assets.js';
import { parseManifest } from './utils/manifest.js';
import { runNpm } from './utils/process.js';
import { chooseSingleTarget } from './utils/targets.js';

export async function validateAppPlusOutput(appPlusDir, manifest) {
  const outputStat = await stat(appPlusDir).catch(() => null);
  if (!outputStat?.isDirectory()) throw new Error(`App-plus 输出目录不存在：${appPlusDir}`);
  if (!(await readdir(appPlusDir)).length) throw new Error(`App-plus 输出目录为空：${appPlusDir}`);
  let generated;
  try { generated = JSON.parse(await readFile(path.join(appPlusDir, 'manifest.json'), 'utf8')); }
  catch (error) { throw new Error(`App-plus manifest.json 读取或解析失败：${error.message}`); }
  if (generated.id !== manifest.appId) throw new Error(`App-plus App ID 不一致：期望 ${manifest.appId}，实际 ${generated.id ?? '未配置'}`);
  if (String(generated.version?.name ?? '') !== manifest.versionName) throw new Error(`App-plus versionName 不一致：期望 ${manifest.versionName}`);
  if (String(generated.version?.code ?? '') !== manifest.versionCode) throw new Error(`App-plus versionCode 不一致：期望 ${manifest.versionCode}`);
}

export async function buildAppPlus(target, targetConfig) {
  const { manifestPath } = await validateUniappProject(target);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  if (targetConfig?.localAssets) await buildLocalAssets(target.name, targetConfig);
  const appPlusDir = path.join(target.dir, 'dist', 'build', 'app-plus');
  await assertSafePath(appPlusDir, { fieldName: `${target.name} App-plus 输出目录`, allowMissing: true });
  await rm(appPlusDir, { recursive: true, force: true });
  await runNpm(['run', 'build:app-plus'], { cwd: target.dir, label: 'App-plus 构建' });
  await validateAppPlusOutput(appPlusDir, manifest);
  return { appPlusDir, relativeAppPlusDir: path.join(target.relativeDir, 'dist', 'build', 'app-plus'), manifest };
}

async function main() {
  const { targets, availableNames } = await readBuildConfig();
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  const target = await resolveUniappTarget(name, targets[name]);
  console.log(`[build:app-plus] 正在构建 ${name} (${target.relativeDir})`);
  const result = await buildAppPlus(target, targets[name]);
  console.log(`[build:app-plus] ${name} 构建成功（${result.manifest.appId}，${result.manifest.versionName}，${result.manifest.versionCode}）`);
  console.log('App-plus 输出目录');
  console.log(result.relativeAppPlusDir);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`[build:app-plus] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });