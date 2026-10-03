import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath, validateUniappProject } from './utils/config.js';
import { buildLocalAssets } from './build-local-assets.js';
import { parseManifest } from './utils/manifest.js';
import { runNpm } from './utils/process.js';

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

export async function buildAppPlus(target, targetConfig, {
  buildLocalAssetsImpl = buildLocalAssets,
  runNpmImpl = runNpm,
  validateAppPlusOutputImpl = validateAppPlusOutput
} = {}) {
  const { manifestPath } = await validateUniappProject(target);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  if (targetConfig?.localAssets) await buildLocalAssetsImpl(target.name, targetConfig);
  const appPlusDir = path.join(target.dir, 'dist', 'build', 'app-plus');
  await assertSafePath(appPlusDir, { fieldName: `${target.name} App-plus 输出目录`, allowMissing: true });
  await rm(appPlusDir, { recursive: true, force: true });
  await runNpmImpl(['run', 'build:app-plus'], { cwd: target.dir, label: 'App-plus 构建' });
  await validateAppPlusOutputImpl(appPlusDir, manifest);
  return { appPlusDir, relativeAppPlusDir: path.join(target.relativeDir, 'dist', 'build', 'app-plus'), manifest };
}