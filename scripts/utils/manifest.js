function stripJsonComments(source) {
  let result = '', inString = false, escaped = false, line = false, block = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index], next = source[index + 1];
    if (line) { if (current === '\n' || current === '\r') { line = false; result += current; } continue; }
    if (block) { if (current === '*' && next === '/') { block = false; index += 1; } else if (current === '\n' || current === '\r') result += current; continue; }
    if (inString) { result += current; if (escaped) escaped = false; else if (current === '\\') escaped = true; else if (current === '"') inString = false; continue; }
    if (current === '"') { inString = true; result += current; }
    else if (current === '/' && next === '/') { line = true; index += 1; }
    else if (current === '/' && next === '*') { block = true; index += 1; }
    else result += current;
  }
  if (block) throw new Error('manifest.json 包含未闭合的块注释');
  return result;
}

export function parseManifest(content) {
  let value;
  try { value = JSON.parse(stripJsonComments(content)); }
  catch (error) { throw new Error(`manifest.json 解析失败：${error.message}`); }
  const appId = typeof value.appid === 'string' ? value.appid.trim() : '';
  const versionName = typeof value.versionName === 'string' ? value.versionName.trim() : '';
  if (!/^__UNI__[0-9A-F]+$/i.test(appId)) throw new Error(`manifest.json 的 appid 无效：${appId || '未配置'}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versionName)) throw new Error('manifest.json 的 versionName 必须符合 major.minor.patch 格式');
  if (typeof value.versionCode !== 'string' || !/^[1-9]\d*$/.test(value.versionCode)) throw new Error('manifest.json 的 versionCode 必须是正整数字符串');
  const versionCodeNumber = Number(value.versionCode);
  if (!Number.isSafeInteger(versionCodeNumber)) throw new Error('manifest.json 的 versionCode 超出安全整数范围');
  return { value, appId, versionName, versionCode: value.versionCode, versionCodeNumber };
}

