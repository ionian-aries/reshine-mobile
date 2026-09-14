import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath } from '../scripts/utils/config.js';
import { parseManifest } from '../scripts/utils/manifest.js';
import { parseSingleTarget } from '../scripts/utils/targets.js';

test('单目标参数只接受 --target', () => {
  assert.equal(parseSingleTarget(['--target', 'online'], ['online', 'local']), 'online');
  assert.throws(() => parseSingleTarget(['--targets', 'online'], ['online']), /仅支持参数 --target/);
  assert.throws(() => parseSingleTarget(['--target', 'missing'], ['online']), /未知项目/);
});

test('JSONC 注释不会破坏字符串且校验顶层版本', () => {
  const content = `{// comment\n"appid":"__UNI__ABC123","versionName":"1.2.3","versionCode":"4","nested":{"versionName":"9.9.9"},"url":"https://a/b"}`;
  const parsed = parseManifest(content);
  assert.equal(parsed.value.url, 'https://a/b');
  assert.deepEqual(parsed, {
    value: { appid: '__UNI__ABC123', versionName: '1.2.3', versionCode: '4', nested: { versionName: '9.9.9' }, url: 'https://a/b' },
    appId: '__UNI__ABC123', versionName: '1.2.3', versionCode: '4', versionCodeNumber: 4
  });
});

test('路径安全检查拒绝符号链接逃逸', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'reshine-outside-'));
  const fixture = path.join(projectRoot, '.path-safety-test');
  await mkdir(fixture, { recursive: true });
  const link = path.join(fixture, 'outside');
  await symlink(outside, link);
  try { await assert.rejects(assertSafePath(path.join(link, 'output'), { fieldName: '测试路径', allowMissing: true }), /符号链接/); }
  finally { const { rm } = await import('node:fs/promises'); await rm(fixture, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
