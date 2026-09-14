import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runNpm } from './utils/process.js';
import { assertSafePath, normalizeError, readBuildConfig, resolveUniappTarget, validateUniappProject } from './utils/config.js';
import { chooseSingleTarget } from './utils/targets.js';

async function buildAppPlus(target) {
  const appPlusDir = path.join(target.dir, 'dist', 'build', 'app-plus');
  await assertSafePath(appPlusDir, { fieldName: `${target.name} App-plus 输出目录`, allowMissing: true });
  target.appPlusDir = appPlusDir;
  target.relativeAppPlusDir = path.join(target.relativeDir, 'dist', 'build', 'app-plus');
  await rm(target.appPlusDir, { recursive: true, force: true });
  await runNpm(['run', 'build:app-plus'], { cwd: target.dir, label: 'App-plus 构建' });
  const outputStat = await stat(target.appPlusDir).catch(() => null);
  if (!outputStat?.isDirectory()) throw new Error(`App-plus 输出目录不存在：${target.relativeAppPlusDir}`);
  const entries = await readdir(target.appPlusDir);
  if (entries.length === 0) throw new Error(`App-plus 输出目录为空：${target.relativeAppPlusDir}`);
}

async function main() {
  const { targets, availableNames } = await readBuildConfig();
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  const target = await resolveUniappTarget(name, targets[name]);
  await validateUniappProject(target);
  console.log(`[build:app-plus] 正在构建 ${name} (${target.relativeDir})`);
  await buildAppPlus(target);
  console.log(`[build:app-plus] ${name} 构建成功`);
  console.log('App-plus 输出目录');
  console.log(target.relativeAppPlusDir);
}

main().catch((error) => { console.error(`[build:app-plus] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });
