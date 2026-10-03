import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(rootDir, 'build.config.json');

function isInside(base, candidate, allowSame = false) {
  const relative = path.relative(base, candidate);
  return (allowSame && relative === '') || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export async function assertSafePath(candidate, { fieldName = '路径', allowMissing = false } = {}) {
  const resolved = path.resolve(candidate);
  if (!isInside(rootDir, resolved)) throw new Error(`${fieldName} 必须位于项目根目录内`);

  const rootReal = await realpath(rootDir);
  let existing = resolved;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (!allowMissing && existing !== resolved) throw new Error(`${fieldName} 不存在：${path.relative(rootDir, resolved)}`);
  const existingReal = await realpath(existing);
  if (!isInside(rootReal, existingReal, true)) throw new Error(`${fieldName} 通过符号链接指向项目根目录外`);
  return resolved;
}

export async function resolveProjectPath(value, fieldName, { allowMissing = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少 ${fieldName}`);
  if (path.isAbsolute(value)) throw new Error(`${fieldName} 必须是项目根目录内的相对路径`);
  const absolutePath = path.resolve(rootDir, value);
  if (!isInside(rootDir, absolutePath)) throw new Error(`${fieldName} 必须位于项目根目录内`);
  await assertSafePath(absolutePath, { fieldName, allowMissing });
  return { absolutePath, relativePath: path.relative(rootDir, absolutePath) };
}

export async function readBuildConfig() {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw new Error(`build.config.json 读取或解析失败：${error.message}`); }
  const targets = config.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('build.config.json 中未配置有效的 targets');
  const availableNames = Object.keys(targets);
  if (availableNames.length === 0) throw new Error('build.config.json 中未配置 targets');
  return { apk: config.apk, targets, availableNames };
}

export async function resolveUniappTarget(name, target) {
  const uniapp = await resolveProjectPath(target?.uniapp?.dir, `${name}.uniapp.dir`);
  return { name, dir: uniapp.absolutePath, relativeDir: uniapp.relativePath };
}

export async function validateUniappProject(target) {
  const packagePath = path.join(target.dir, 'package.json');
  const manifestPath = path.join(target.dir, 'src', 'manifest.json');
  await Promise.all([access(packagePath), access(manifestPath)]);
  await Promise.all([
    assertSafePath(packagePath, { fieldName: `${target.name} package.json` }),
    assertSafePath(manifestPath, { fieldName: `${target.name} manifest.json` })
  ]);
  return { packagePath, manifestPath };
}