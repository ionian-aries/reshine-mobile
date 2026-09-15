import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeError, readBuildConfig } from './utils/config.js';
import { runCommand } from './utils/process.js';

const execFileAsync = promisify(execFile);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireImage(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('build.config.json 缺少 apk.image');
  return value.trim();
}

export function createDockerBuildArgs(image) {
  return ['build', '--platform', 'linux/amd64', '--tag', requireImage(image), '.'];
}

async function runDockerBuild(image) {
  await runCommand('docker', createDockerBuildArgs(image), { cwd: rootDir, label: 'Docker Android 镜像构建' });
}

async function inspectImage(image) {
  const { stdout } = await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}\t{{.Os}}/{{.Architecture}}\t{{.Size}}', image], { cwd: rootDir });
  const [id, platform, size] = stdout.trim().split('\t');
  if (!id || !platform || !size) throw new Error('Docker Android 镜像校验返回无效结果');
  return { id, platform, size: Number(size) };
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function main() {
  const { apk } = await readBuildConfig();
  const image = requireImage(apk?.image);
  console.log(`[build:image] 正在构建 Android 离线镜像：${image}`);
  await runDockerBuild(image);
  const details = await inspectImage(image);
  console.log(`[build:image] 构建成功：${image}`);
  console.log(`[build:image] 镜像信息：${details.id}，${details.platform}，${formatBytes(details.size)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`[build:image] 构建失败：${normalizeError(error).message}`); process.exitCode = 1; });