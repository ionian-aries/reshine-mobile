import { UpgradeError } from './errors.js'

function invalid(message, data) {
  throw new UpgradeError('INVALID_RESPONSE', message, { data, retryable: true, phase: 'checking' })
}

export function validateCheckUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpgradeError('CONFIG_MISSING', '缺少 VUE_APP_UPGRADE_CHECK_URL', { phase: 'checking' })
  }
  return value.trim()
}

export function validatePackage(packageInfo) {
  if (!packageInfo || typeof packageInfo !== 'object') invalid('更新响应缺少 package', packageInfo)
  if (packageInfo.type !== 'apk' && packageInfo.type !== 'wgt') invalid('更新包 type 仅允许 apk 或 wgt', packageInfo.type)
  if (typeof packageInfo.url !== 'string' || !packageInfo.url.trim()) invalid('更新包缺少 url', packageInfo.url)
  if (packageInfo.type === 'wgt' && (typeof packageInfo.version !== 'string' || !packageInfo.version.trim())) invalid('WGT 更新包缺少 version', packageInfo.version)
  return Object.freeze({
    ...packageInfo,
    url: packageInfo.url.trim(),
    title: typeof packageInfo.title === 'string' && packageInfo.title ? packageInfo.title : '客户端更新',
    contents: typeof packageInfo.contents === 'string' && packageInfo.contents ? packageInfo.contents : '发现新的客户端更新'
  })
}

export function parseResponse(body, current) {
  if (!body || typeof body !== 'object') invalid('更新响应结构非法', body)
  if (body.code !== 200) {
    throw new UpgradeError('SERVER_ERROR', body.message || '更新服务返回业务错误', {
      data: body, retryable: true, phase: 'checking'
    })
  }
  if (!body.data || typeof body.data !== 'object') invalid('更新响应缺少 data', body)
  if (body.data.action === 'none') return { action: 'none', current }
  if (body.data.action !== 'update') invalid('未知的更新 action', body.data.action)
  const packageInfo = validatePackage(body.data.package)
  if (packageInfo.type === 'wgt' && current && compareVersions(packageInfo.version, current.wgtVersion) <= 0) {
    invalid(`WGT 目标版本必须高于当前资源版本 ${current.wgtVersion}`, packageInfo)
  }
  return { action: 'update', current, package: packageInfo }
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(value => Number(value))
  const b = String(right || '').split('.').map(value => Number(value))
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const av = Number.isFinite(a[index]) ? a[index] : 0
    const bv = Number.isFinite(b[index]) ? b[index] : 0
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}