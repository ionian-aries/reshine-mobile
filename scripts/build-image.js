import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeError, readBuildConfig } from './utils/config.js';
import { runCommand } from './utils/process.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireImage(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('build.config.json 缺少 apk.image');
  return value.trim();
}

export function createDockerBuildArgs(image) {
  return ['build', '--platform', 'linux/amd64', '--tag', requireImage(image), '.'];
}

async function main() {
  const { apk } = await readBuildConfig();
  const image = requireImage(apk?.image);
  console.log(`[build:image] 正在构建 Android 离线镜像 ${image}`);
  await runCommand('docker', createDockerBuildArgs(image), { cwd: rootDir, label: 'Docker Android 镜像构建' });
  await runCommand('docker', ['image', 'inspect', image], { cwd: rootDir, label: 'Docker Android 镜像校验' });
  console.log(`[build:image] Android 离线镜像构建成功：${image}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`[build:image] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });