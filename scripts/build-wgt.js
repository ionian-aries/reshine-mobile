import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { assertSafePath, normalizeError, readBuildConfig, resolveProjectPath, resolveUniappTarget } from './utils/config.js';
import { buildAppPlus } from './build-app-plus.js';
import { chooseSingleTarget } from './utils/targets.js';

async function resolveTarget(name, config) {
  const target = await resolveUniappTarget(name, config);
  const output = await resolveProjectPath(config?.output?.wgtDir, `${name}.output.wgtDir`, { allowMissing: true });
  const appPlusDir = path.join(target.dir, 'dist', 'build', 'app-plus');
  await assertSafePath(appPlusDir, { fieldName: `${name} App-plus 输出目录`, allowMissing: true });
  await assertSafePath(path.dirname(output.absolutePath), { fieldName: `${name} WGT 输出父目录`, allowMissing: true });
  return {
    ...target,
    appPlusDir,
    relativeAppPlusDir: path.join(target.relativeDir, 'dist', 'build', 'app-plus'),
    wgtDir: output.absolutePath,
    relativeWgtDir: output.relativePath
  };
}

async function createWgt(sourceDir, wgtPath) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(wgtPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    output.once('close', () => { if (!settled) { settled = true; resolve(); } });
    output.once('error', fail);
    archive.once('warning', fail);
    archive.once('error', fail);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize().catch(fail);
  });
}

async function validateWgt(wgtDir, wgtPath, manifest) {
  const info = await stat(wgtPath).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`WGT 文件不存在或为空：${path.relative(process.cwd(), wgtPath)}`);
  const entries = await readdir(wgtDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== path.basename(wgtPath)) throw new Error(`WGT 输出目录必须且只能包含 ${path.basename(wgtPath)}`);
  const archive = await unzipper.Open.file(wgtPath);
  if (!archive.files.length) throw new Error('WGT 压缩包为空');
  if (archive.files.some((entry) => entry.path === 'app-plus/' || entry.path.startsWith('app-plus/'))) throw new Error('WGT 压缩包错误地包含顶层 app-plus 目录');
  const manifestEntry = archive.files.find((entry) => entry.path === 'manifest.json');
  if (!manifestEntry) throw new Error('WGT 压缩包根目录缺少 manifest.json');
  let packagedManifest;
  try { packagedManifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')); }
  catch (error) { throw new Error(`WGT 内 manifest.json 解析失败：${error.message}`); }
  if (packagedManifest.id !== manifest.appId) throw new Error(`WGT 内 App ID 不一致：期望 ${manifest.appId}`);
  if (String(packagedManifest.version?.name ?? '') !== manifest.versionName) throw new Error(`WGT 内 versionName 不一致：期望 ${manifest.versionName}`);
  if (String(packagedManifest.version?.code ?? '') !== manifest.versionCode) throw new Error(`WGT 内 versionCode 不一致：期望 ${manifest.versionCode}`);
}

async function main() {
  const { targets, availableNames } = await readBuildConfig();
  const name = await chooseSingleTarget(process.argv.slice(2), availableNames);
  const target = await resolveTarget(name, targets[name]);
  console.log(`[build:wgt] 正在构建 ${name} (${target.relativeDir})`);
  await mkdir(path.dirname(target.wgtDir), { recursive: true });
  await rm(target.wgtDir, { recursive: true, force: true });
  await mkdir(target.wgtDir, { recursive: true });
  const { manifest } = await buildAppPlus(target, targets[name]);
  const wgtPath = path.join(target.wgtDir, `${manifest.appId}.wgt`);
  await assertSafePath(wgtPath, { fieldName: `${name} WGT 文件`, allowMissing: true });
  await createWgt(target.appPlusDir, wgtPath);
  await validateWgt(target.wgtDir, wgtPath, manifest);
  console.log(`[build:wgt] ${name} 构建成功（${manifest.appId}，${manifest.versionName}，${manifest.versionCode}）`);
  console.log('WGT 文件:');
  console.log(path.join(target.relativeWgtDir, path.basename(wgtPath)));
}

main().catch((error) => { console.error(`[build:wgt] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });