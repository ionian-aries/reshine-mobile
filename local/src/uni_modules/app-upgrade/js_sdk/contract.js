import { UpgradeError } from './errors.js'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseVersion(value, field) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new UpgradeError('INVALID_RESPONSE', `${field} 必须是三段非负整数版本号`, {
      data: { field, value },
      phase: 'checking'
    })
  }
  return value.split('.').map(Number)
}

export function compareVersions(left, right) {
  const a = parseVersion(left, 'version')
  const b = parseVersion(right, 'version')
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function parseAbsoluteUrl(value) {
  if (typeof URL === 'function') return new URL(value)

  const matched = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(value)
  if (!matched) throw new Error('Invalid URL')

  const authority = matched[2]
  const hostname = authority.charAt(0) === '['
    ? authority.slice(1, authority.indexOf(']'))
    : authority.split(':')[0]

  if (!hostname) throw new Error('Invalid URL')

  return {
    protocol: `${matched[1].toLowerCase()}:`,
    hostname,
    pathname: matched[3] || '/',
    toString() {
      return value
    }
  }
}

export function validateCheckUrl(value, allowHttp = false) {
  if (!value || typeof value !== 'string') {
    throw new UpgradeError('CONFIG_MISSING', '缺少 VUE_APP_UPGRADE_CHECK_URL', { phase: 'checking' })
  }
  let parsed
  try {
    parsed = parseAbsoluteUrl(value.trim())
  } catch (error) {
    throw new UpgradeError('CONFIG_INVALID', '更新检查地址不是合法的完整 URL', { data: value, phase: 'checking' })
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/' || (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:'))) {
    throw new UpgradeError('CONFIG_INVALID', '更新检查地址必须包含协议、主机和接口路径', { data: value, phase: 'checking' })
  }
  return parsed.toString()
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpgradeError('INVALID_RESPONSE', `更新包缺少 ${field}`, { data: { field, value }, phase: 'checking' })
  }
}

export function validatePackage(packageInfo, current, options) {
  if (!packageInfo || typeof packageInfo !== 'object') {
    throw new UpgradeError('INVALID_RESPONSE', '更新响应缺少 package', { phase: 'checking' })
  }
  ;['id', 'appid', 'title', 'contents', 'type', 'version', 'url'].forEach(field => requireString(packageInfo[field], field))
  if (packageInfo.type !== 'apk' && packageInfo.type !== 'wgt') {
    throw new UpgradeError('INVALID_RESPONSE', '更新包 type 仅允许 apk 或 wgt', { phase: 'checking' })
  }
  if (packageInfo.appid !== current.appid) {
    throw new UpgradeError('APPID_MISMATCH', '更新包 AppID 与当前应用不一致', { phase: 'checking' })
  }
  const installedVersion = packageInfo.type === 'apk' ? current.apkVersion : current.wgtVersion
  if (compareVersions(packageInfo.version, installedVersion) <= 0) {
    throw new UpgradeError('VERSION_DOWNGRADE_REJECTED', '目标版本未高于当前版本', { phase: 'checking' })
  }
  if (packageInfo.type === 'wgt') {
    requireString(packageInfo.min_uni_version, 'min_uni_version')
    if (compareVersions(packageInfo.min_uni_version, current.apkVersion) > 0) {
      throw new UpgradeError('VERSION_DOWNGRADE_REJECTED', '当前 APK 不满足 WGT 最低版本要求', { phase: 'checking' })
    }
  }
  let downloadUrl
  try {
    downloadUrl = parseAbsoluteUrl(packageInfo.url.trim())
  } catch (error) {
    throw new UpgradeError('UNTRUSTED_DOWNLOAD_URL', '下载地址非法', { phase: 'checking' })
  }
  const protocolAllowed = downloadUrl.protocol === 'https:' || (options.allowHttp && downloadUrl.protocol === 'http:')
  const hostAllowed = !options.allowedDownloadHosts.length || options.allowedDownloadHosts.indexOf(downloadUrl.hostname) >= 0
  if (!protocolAllowed || !hostAllowed) {
    throw new UpgradeError('UNTRUSTED_DOWNLOAD_URL', '下载地址协议或域名不可信', { data: packageInfo.url, phase: 'checking' })
  }
  if (packageInfo.size != null && (!Number.isSafeInteger(packageInfo.size) || packageInfo.size <= 0)) {
    throw new UpgradeError('INVALID_RESPONSE', '更新包 size 非法', { phase: 'checking' })
  }
  return Object.freeze({ ...packageInfo, url: downloadUrl.toString() })
}

export function parseResponse(body, current, options) {
  if (!body || typeof body !== 'object' || body.code !== 200 || !body.data) {
    if (body && body.code !== 200) {
      throw new UpgradeError('SERVER_ERROR', body.message || '更新服务返回业务错误', {
        data: body,
        retryable: true,
        phase: 'checking'
      })
    }
    throw new UpgradeError('INVALID_RESPONSE', '更新响应结构非法', { data: body, phase: 'checking' })
  }
  if (body.data.action === 'none') return { action: 'none', current }
  if (body.data.action !== 'update') {
    throw new UpgradeError('INVALID_RESPONSE', '未知的更新 action', { data: body.data.action, phase: 'checking' })
  }
  return { action: 'update', current, package: validatePackage(body.data.package, current, options) }
}