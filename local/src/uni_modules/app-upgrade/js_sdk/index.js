import { resolveOptions } from './config.js'
import { parseResponse, validatePackage } from './contract.js'
import { UpgradeError, toUpgradeError } from './errors.js'
import { clearUpdateDirectory, downloadPackage, getAppInfo, inspectLocalPackage, installWgt, isAndroidApp, openApkUrl, requestRuntimeRestart, savePendingWgt, validatePendingWgt } from './runtime.js'

const initialState = () => ({ phase: 'idle', current: null, packageInfo: null, progress: null, error: null, mandatoryConfirmed: false, downloadConfirmed: false })
let state = initialState()
let busy = false
let lastOptions = {}
let listeners = new Set()

function now() { return Date.now() }
function processInfo() {
  return {
    processId: typeof plus !== 'undefined' && plus.runtime && plus.runtime.processId != null ? plus.runtime.processId : null,
    startupTime: typeof plus !== 'undefined' && plus.runtime && plus.runtime.startupTime != null ? plus.runtime.startupTime : null
  }
}

function snapshot() { return Object.freeze({ ...state, progress: state.progress && { ...state.progress } }) }
function emit(patch, options = lastOptions) {
  state = { ...state, ...patch }
  const value = snapshot()
  listeners.forEach(listener => listener(value))
  if (typeof options.onStateChange === 'function') options.onStateChange(value)
}
function fail(error, options) {
  const value = toUpgradeError(error, { code: 'UPDATE_FAILED', message: '更新失败', retryable: true, phase: state.phase })
  emit({ phase: 'failed', error: value }, options)
  return Promise.reject(value)
}

function requestCheck(url, data, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (task && typeof task.abort === 'function') task.abort()
      reject(new UpgradeError('CHECK_TIMEOUT', '更新检查超时', { retryable: true, phase: 'checking' }))
    }, timeout)
    let task = uni.request({
      url, method: 'POST', data, header: { 'content-type': 'application/json' },
      success(response) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
          reject(new UpgradeError('CHECK_HTTP_ERROR', `更新检查 HTTP ${response.statusCode}`, { retryable: true, phase: 'checking' }))
        } else resolve(response.data)
      },
      fail(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new UpgradeError('CHECK_NETWORK_ERROR', error.errMsg || '更新检查网络错误', { data: error, retryable: true, phase: 'checking' }))
      }
    })
  })
}

async function fullCheck(options = {}) {
  const config = resolveOptions(options)
  lastOptions = options
  if (!config.enabled) return { action: 'skipped', status: 'disabled', reason: 'upgrade-check-url-missing' }
  emit({ phase: 'checking-runtime', error: null, progress: null }, config)
  const info = await getAppInfo()
  if (info.status !== 'success') throw new UpgradeError(info.code, info.message, { retryable: true, phase: 'checking-runtime' })
  emit({ current: info.data }, config)
  const recovery = await validatePendingWgt(info.data).catch(error => {
    if (error && (error.code === 'WGT_ACTIVATION_FAILED' || error.code === 'WGT_INSTALL_INTERRUPTED')) {
      const pending = error.data && error.data.pending
      emit({ mandatoryConfirmed: true, packageInfo: {
        type: 'wgt',
        title: error.code === 'WGT_INSTALL_INTERRUPTED' ? 'WGT 安装异常中断' : 'WGT 资源未生效',
        contents: error.code === 'WGT_INSTALL_INTERRUPTED'
          ? '更新包安装期间应用异常结束，已停止自动重试，请重新下载后再试。'
          : '安装后的资源版本与预期不一致，已停止自动安装和重启。',
        version: error.data.expected && error.data.expected.version,
        versionCode: error.data.expected && error.data.expected.versionCode,
        expected: error.data.expected, current: error.data.current,
        installedWidgetInfo: pending && pending.installedWidgetInfo
      } }, config)
    }
    throw error
  })
  if (recovery.status === 'resume-install') {
    emit({ phase: 'installing', mandatoryConfirmed: true, packageInfo: {
      type: 'wgt', title: '正在恢复资源更新', contents: '检测到上次下载完成但安装被中断，正在继续安装。',
      version: recovery.expected.version, versionCode: recovery.expected.versionCode, expected: recovery.expected
    } }, config)
    const fileInfo = await inspectLocalPackage(recovery.pending.sourcePath)
    const installRequested = savePendingWgt({
      ...recovery.pending, stage: 'install-requested', fileInfo,
      installAttempts: Number(recovery.pending.installAttempts || 0) + 1,
      ...processInfo(), installRequestedAt: now()
    })
    const installedWidgetInfo = await installWgt(installRequested.sourcePath, recovery.expected, { attemptId: installRequested.attemptId })
    const installed = savePendingWgt({
      ...installRequested, stage: 'installed', installedWidgetInfo: installedWidgetInfo || null,
      ...processInfo(), installedAt: now()
    })
    emit({ phase: 'restarting-wgt' }, config)
    requestRuntimeRestart(installed)
    return { action: 'recovering', status: 'restart-requested' }
  }
  if (recovery.status === 'resume-restart') {
    emit({ phase: 'restarting-wgt', mandatoryConfirmed: true, packageInfo: {
      type: 'wgt', title: '正在恢复资源更新', contents: '资源已安装，正在再次请求热重启。',
      version: recovery.expected.version, versionCode: recovery.expected.versionCode, expected: recovery.expected
    } }, config)
    requestRuntimeRestart(recovery.pending)
    return { action: 'recovering', status: 'restart-requested' }
  }
  emit({ phase: 'cleaning' }, config)
  await clearUpdateDirectory()
  emit({ phase: 'checking' }, config)
  const body = await requestCheck(config.checkUrl, {
    appid: info.data.appid,
    apkVersion: info.data.apkVersion,
    wgtVersion: info.data.wgtVersion
  }, config.timeout)
  const result = parseResponse(body, info.data)
  if (result.action === 'none') emit({ phase: 'no-update', packageInfo: null, mandatoryConfirmed: false, downloadConfirmed: false }, config)
  else emit({ phase: 'update-available', packageInfo: result.package, mandatoryConfirmed: true, downloadConfirmed: false }, config)
  return result
}

export function check(options = {}) {
  if (!isAndroidApp()) return Promise.resolve({ action: 'skipped', status: 'unsupported-platform' })
  if (busy) return Promise.resolve({ action: 'skipped', status: 'busy' })
  busy = true
  return fullCheck(options).catch(error => fail(error, options)).finally(() => { busy = false })
}

export async function confirmUpdate(options = lastOptions) {
  if (busy) return { action: 'skipped', status: 'busy' }
  if (state.phase !== 'update-available' || !state.packageInfo) throw new UpgradeError('INVALID_RESPONSE', '当前没有等待确认的更新')
  busy = true
  const packageInfo = validatePackage(state.packageInfo)
  const config = resolveOptions(options)
  try {
    emit({ downloadConfirmed: true, progress: null, error: null }, config)
    if (packageInfo.type === 'apk') {
      emit({ phase: 'opening-apk' }, config)
      const onError = error => fail(new UpgradeError('OPEN_URL_FAILED', (error && (error.message || error.errMsg)) || '打开 APK 下载地址失败', {
        data: { packageType: 'apk', runtimeOpenURL: error || null }, retryable: true, phase: 'opening-apk'
      }), config).catch(() => {})
      const result = openApkUrl(packageInfo.url, onError)
      emit({ phase: 'apk-url-opened' }, config)
      return result
    }
    emit({ phase: 'downloading' }, config)
    const downloaded = await downloadPackage(packageInfo.url, packageInfo.type, progress => emit({ progress }, config))
    const expected = {
      appid: state.current.appid,
      version: packageInfo.version,
      ...(packageInfo.versionCode != null ? { versionCode: packageInfo.versionCode } : {})
    }
    const attemptId = `wgt-${now()}-${Math.random().toString(16).slice(2)}`
    const downloadedPending = savePendingWgt({
      attemptId, stage: 'downloaded', url: packageInfo.url, sourcePath: downloaded.filePath, expected,
      httpStatus: downloaded.httpStatus, totalBytes: downloaded.totalBytes, downloadedAt: now()
    })
    emit({ phase: 'installing' }, config)
    const fileInfo = await inspectLocalPackage(downloaded.filePath)
    const installRequested = savePendingWgt({
      ...downloadedPending, stage: 'install-requested', fileInfo, installAttempts: 1,
      ...processInfo(), installRequestedAt: now()
    })
    const installedWidgetInfo = await installWgt(installRequested.sourcePath, expected, { attemptId })
    const installedPending = savePendingWgt({
      ...installRequested, stage: 'installed', expected, sourcePath: downloaded.filePath,
      installedWidgetInfo: installedWidgetInfo || null, ...processInfo(), installedAt: now()
    })
    emit({ phase: 'restarting-wgt' }, config)
    requestRuntimeRestart(installedPending)
    busy = false
    return { restartRequired: true, attemptId }
  } catch (error) {
    busy = false
    return fail(error, config)
  }
}

export function retry() { return check(lastOptions) }
export function dispose() {
  busy = false
  listeners.clear()
  state = initialState()
}
export function getState() { return snapshot() }
export function shouldBlockBack() { return Boolean(state.mandatoryConfirmed) }
export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export { getAppInfo }
export default { check, checkAndUpdate: check, confirmUpdate, retry, dispose, getState, shouldBlockBack, subscribe, getAppInfo }