import { confirm, select } from '@inquirer/prompts';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeError, readBuildConfig, resolveUniappTarget, validateUniappProject } from './utils/config.js';
import { parseManifest } from './utils/manifest.js';
import { chooseSingleTarget, requireInteractiveTerminal } from './utils/targets.js';

const VERSION_NAME_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseManifestVersion(content) {
  const manifest = parseManifest(content);
  const parts = VERSION_NAME_PATTERN.exec(manifest.versionName).slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('versionName 各部分必须位于 JavaScript 安全整数范围内');
  if (manifest.versionCodeNumber >= Number.MAX_SAFE_INTEGER) throw new Error('versionCode 必须是可安全自增的正整数');
  return { versionName: manifest.versionName, versionCode: manifest.versionCodeNumber, versionCodeText: manifest.versionCode, parts };
}

export function calculateVersion(current, level) {
  let [major, minor, patch] = current.parts;
  if (level === 'patch') {
    if (patch >= Number.MAX_SAFE_INTEGER) throw new Error('versionName 的 patch 无法安全自增');
    patch += 1;
  } else if (level === 'minor') {
    if (minor >= Number.MAX_SAFE_INTEGER) throw new Error('versionName 的 minor 无法安全自增');
    minor += 1;
    patch = 0;
  } else if (level === 'major') {
    if (major >= Number.MAX_SAFE_INTEGER) throw new Error('versionName 的 major 无法安全自增');
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    throw new Error(`未知版本升级级别：${level}`);
  }
  return {
    versionName: `${major}.${minor}.${patch}`,
    versionCode: current.versionCode + 1,
    versionCodeText: String(current.versionCode + 1)
  };
}

function findUniqueTopLevelStringField(content, fieldName) {
  const matches = [];
  let depth = 0, lineComment = false, blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index], next = content[index + 1];
    if (lineComment) { if (current === '\n' || current === '\r') lineComment = false; continue; }
    if (blockComment) { if (current === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (current === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (current === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (current === '{' || current === '[') { depth += 1; continue; }
    if (current === '}' || current === ']') { depth -= 1; continue; }
    if (current !== '"' || depth !== 1) continue;
    const keyStart = index + 1;
    let cursor = keyStart;
    for (; cursor < content.length; cursor += 1) {
      if (content[cursor] === '\\') cursor += 1;
      else if (content[cursor] === '"') break;
    }
    const key = content.slice(keyStart, cursor);
    index = cursor;
    if (key !== fieldName) continue;
    cursor += 1;
    while (/\s/.test(content[cursor])) cursor += 1;
    if (content[cursor] !== ':') continue;
    cursor += 1;
    while (/\s/.test(content[cursor])) cursor += 1;
    if (content[cursor] !== '"') throw new Error(`manifest.json 顶层 ${fieldName} 必须是字符串`);
    const valueStart = cursor + 1;
    cursor = valueStart;
    for (; cursor < content.length; cursor += 1) {
      if (content[cursor] === '\\') cursor += 1;
      else if (content[cursor] === '"') { matches.push({ start: valueStart, end: cursor }); break; }
    }
    if (cursor >= content.length) throw new Error(`manifest.json 顶层 ${fieldName} 字符串未闭合`);
  }
  if (matches.length !== 1) throw new Error(`manifest.json 顶层 ${fieldName} 必须且只能出现一次`);
  return matches[0];
}

function replaceVersion(content, current, next) {
  const name = findUniqueTopLevelStringField(content, 'versionName');
  let updated = `${content.slice(0, name.start)}${next.versionName}${content.slice(name.end)}`;
  const code = findUniqueTopLevelStringField(updated, 'versionCode');
  updated = `${updated.slice(0, code.start)}${next.versionCodeText}${updated.slice(code.end)}`;
  return updated;
}

async function writeManifestAtomically(manifestPath, content) {
  const temporaryPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function restoreManifest(manifestPath, originalContent) {
  try {
    await writeManifestAtomically(manifestPath, originalContent);
  } catch (error) {
    throw new Error(`版本校验失败且恢复原文件失败：${normalizeError(error).message}`);
  }
}

export async function main() {
  const { targets, availableNames } = await readBuildConfig();
  console.log(`可用项目：${availableNames.join('、')}`);
  const targetName = await chooseSingleTarget(process.argv.slice(2), availableNames);
  requireInteractiveTerminal('升级级别和最终确认');

  const target = await resolveUniappTarget(targetName, targets[targetName]);
  const { manifestPath } = await validateUniappProject(target);
  const originalContent = await readFile(manifestPath, 'utf8');
  const current = parseManifestVersion(originalContent);
  const levels = [
    { value: 'patch', label: 'patch（修订）' },
    { value: 'minor', label: 'minor（次版）' },
    { value: 'major', label: 'major（主版）' }
  ];
  const previews = Object.fromEntries(levels.map(({ value }) => [value, calculateVersion(current, value)]));

  console.log(`当前版本 · ${targetName}`);
  console.log(`  versionName  ${current.versionName}`);
  console.log(`  versionCode  ${current.versionCodeText}`);
  console.log('升级方式');
  console.log('  patch  修订版本 +1');
  console.log('  minor  次版本 +1，修订版本归零');
  console.log('  major  主版本 +1，次版本和修订版本归零');
  console.log(`  versionCode 每次发布固定 +1：${current.versionCodeText} → ${current.versionCode + 1}`);

  const level = await select({
    message: '请选择版本升级级别',
    choices: levels.map(({ value, label }) => ({
      name: `${label}  ${current.versionName} → ${previews[value].versionName}`,
      value
    }))
  });
  const next = previews[level];
  const levelLabel = levels.find(({ value }) => value === level).label;

  console.log(`目标：${targetName}`);
  console.log(`升级级别：${levelLabel}`);
  console.log(`versionName: ${current.versionName} -> ${next.versionName}`);
  console.log(`versionCode: ${current.versionCodeText} -> ${next.versionCodeText}`);

  if (!await confirm({ message: '确认更新以上版本？', default: false })) {
    console.log('已取消，未修改版本');
    return;
  }

  const updatedContent = replaceVersion(originalContent, current, next);
  await writeManifestAtomically(manifestPath, updatedContent);
  try {
    const verifiedContent = await readFile(manifestPath, 'utf8');
    const verified = parseManifestVersion(verifiedContent);
    if (verified.versionName !== next.versionName || verified.versionCodeText !== next.versionCodeText) {
      throw new Error('写入后版本校验不一致');
    }
    const expectedContent = replaceVersion(verifiedContent, verified, current);
    if (expectedContent !== originalContent) {
      throw new Error('写入后发现版本字段之外的内容发生变化');
    }
  } catch (error) {
    await restoreManifest(manifestPath, originalContent);
    throw error;
  }
  console.log('更新成功');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(`更新失败：${normalizeError(error).message}`);
  process.exitCode = 1;
});