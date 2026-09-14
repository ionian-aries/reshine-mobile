#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function fail(message) { throw new Error(message); }
function safeName(value) {
  const normalized = String(value).normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) fail('应用名称无法生成安全 APK 文件名');
  return normalized;
}

export async function exportMetadata(configPath, apkPath, outputPath, fingerprintArg, imageArg) {
  const image = String(imageArg ?? '').trim();
  const fingerprint = String(fingerprintArg ?? '').trim().replaceAll(':', '').toLowerCase();
  if (!image) fail('构建镜像标识不能为空');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail('签名证书 SHA-256 指纹格式无效');
  const info = await stat(apkPath).catch(() => null);
  if (!info?.isFile() || info.size === 0) fail('APK 必须是非空普通文件');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const expectedImage = config?.template?.image;
  if (expectedImage !== undefined && (typeof expectedImage !== 'string' || !expectedImage.trim())) fail('template.image 必须是非空字符串');
  if (expectedImage?.trim() && expectedImage.trim() !== image) fail('运行时 config 中的镜像标识与实际镜像不一致');
  const apk = await readFile(apkPath);
  const sha256 = createHash('sha256').update(apk).digest('hex');
  const fileName = `${safeName(config.uniapp.name)}-${safeName(config.uniapp.versionName)}-${config.uniapp.versionCode}.apk`;
  const metadata = {
    schemaVersion: 1,
    result: 'success',
    app: {
      name: config.uniapp.name,
      appid: config.uniapp.appid,
      applicationId: config.android.applicationId,
      namespace: config.android.namespace,
      versionName: config.uniapp.versionName,
      versionCode: config.uniapp.versionCode
    },
    template: { hbuilderxVersion: config.template.hbuilderxVersion, image },
    apk: { fileName: path.basename(fileName), sha256, size: info.size },
    signing: { certificateSha256: fingerprint }
  };
  await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  return metadata;
}

async function main() {
  const [configPath, apkPath, outputPath, fingerprint, image] = process.argv.slice(2);
  if (!configPath || !apkPath || !outputPath || !fingerprint || !image) fail('用法：export-metadata.js <config.json> <apk> <output.json> <certificateFingerprint> <image>');
  await exportMetadata(configPath, apkPath, outputPath, fingerprint, image);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`构建元数据导出失败：${error.message}`); process.exitCode = 1; });