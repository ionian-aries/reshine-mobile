import { resolveOptions } from './config.js'
import { parseResponse, validatePackage } from './contract.js'
import { UpgradeError, toUpgradeError } from './errors.js'
import { assertAndroidApp, getCurrentVersions, installPackage } from './runtime.js'
import { log, logError } from './logger.js'

const initialState = () => ({
  phase: 'idle', current: null, packageInfo: null, progress: null,
  error: null, mandatoryConfirmed: false
})

let state = initialState()
let activePromise = null
let downloadTask = null
let lastOperation = null
let listeners = new Set()

function snapshot() {
  return Object.freeze({ ...state, progress: state.progress && { ...state.progress } })
}

function emit(patch, options) {
  const previousPhase = state.phase
  state = { ...state, ...patch }
  if (patch.phase && patch.phase !== previousPhase) {
    log('state.transition', { from: previousPhase, to: patch.phase })
  }
  const value = snapshot()
  listeners.forEach(listener => listener(value))
  if (options && typeof options.onStateChange === 'function') options.onStateChange(value)
}

function fail(error, options) {
  logError('flow.failed', error)
  emit({ phase: 'failed', error }, options)
  throw error
}

function requestCheck(url, data, timeout) {
  log('request.start', { url, method: 'POST', timeout })
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      log('request.timeout', { url, timeout })
      reject(new UpgradeError('CHECK_TIMEOUT', '更新检查超时', { retryable: true, phase: 'checking' }))
    }, timeout)
    uni.request({
      url, method: 'POST', data,
      header: { 'content-type': 'application/json' },
      success(response) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        log('request.response', {
          url,
          httpStatus: response.statusCode,
          businessCode: response.data && response.data.code,
          action: response.data && response.data.data && response.data.data.action,
          hasData: Boolean(response.data && response.data.data)
        })
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new UpgradeError('CHECK_HTTP_ERROR', `更新检查 HTTP ${response.statusCode}`, {
            data: response, retryable: true, phase: 'checking'
          }))
          return
        }
        resolve(response.data)
      },
      fail(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new UpgradeError('CHECK_NETWORK_ERROR', error.errMsg || '更新检查网络错误', {
          data: error, retryable: true, phase: 'checking'
        }))
      }
    })
  })
}

async function doCheck(options = {}) {
  log('flow.start', { operation: 'check' })
  const config = resolveOptions(options)
  log('config.resolved', {
    checkUrl: config.checkUrl,
    timeout: config.timeout,
    autoDownload: config.autoDownload,
    allowHttp: config.allowHttp,
    allowedDownloadHostCount: config.allowedDownloadHosts.length
  })
  assertAndroidApp()
  log('runtime.check-passed', { platform: 'android-app' })
  emit({ phase: 'checking', error: null }, config)
  const current = await getCurrentVersions()
  log('version.collected', current)
  emit({ current }, config)
  const body = await requestCheck(config.checkUrl, {
    appid: current.appid,
    apkVersion: current.apkVersion,
    wgtVersion: current.wgtVersion
  }, config.timeout)
  const result = parseResponse(body, current, config)
  log('contract.validated', {
    action: result.action,
    updateType: result.package && result.package.type,
    targetVersion: result.package && result.package.version
  })
  log('response.decision', {
    action: result.action,
    autoDownload: config.autoDownload,
    willDownload: result.action !== 'none' && config.autoDownload,
    updateType: result.package && result.package.type,
    currentVersion: result.package && result.package.type === 'apk' ? current.apkVersion : current.wgtVersion,
    targetVersion: result.package && result.package.version
  })
  if (result.action === 'none') emit({ phase: 'no-update', packageInfo: null, mandatoryConfirmed: false }, config)
  else emit({ phase: 'update-available', packageInfo: result.package, mandatoryConfirmed: true }, config)
  return result
}

export function check(options = {}) {
  if (activePromise) return activePromise
  lastOperation = { name: 'check', options }
  activePromise = doCheck(options).catch(error => fail(toUpgradeError(error, {
    code: 'CHECK_NETWORK_ERROR', message: '更新检查失败', retryable: true, phase: 'checking'
  }), options)).finally(() => { activePromise = null })
  return activePromise
}

export function download(packageInfo, options = {}) {
  if (downloadTask) return Promise.reject(new UpgradeError('FLOW_IN_PROGRESS', '更新流程正在进行', { phase: 'downloading' }))
  const config = resolveOptions(options)
  const current = state.current
  if (!current) return Promise.reject(new UpgradeError('VERSION_UNAVAILABLE', '请先执行更新检查', { phase: 'downloading' }))
  const checkedPackage = validatePackage(packageInfo, current, config)
  log('download.start', { url: checkedPackage.url, updateType: checkedPackage.type, targetVersion: checkedPackage.version, expectedSize: checkedPackage.size || null })
  let lastLoggedProgress = -10
  lastOperation = { name: 'download-install', packageInfo: checkedPackage, options }
  emit({ phase: 'downloading', packageInfo: checkedPackage, progress: null, error: null }, config)
  activePromise = new Promise((resolve, reject) => {
    downloadTask = uni.downloadFile({
      url: checkedPackage.url,
      success(response) {
        if (response.statusCode !== 200) {
          reject(new UpgradeError('DOWNLOAD_HTTP_ERROR', `下载更新包 HTTP ${response.statusCode}`, {
            data: response, retryable: true, phase: 'downloading'
          }))
          return
        }
        if (!response.tempFilePath) {
          reject(new UpgradeError('DOWNLOAD_FAILED', '下载结果缺少临时文件路径', { retryable: true, phase: 'downloading' }))
          return
        }
        emit({ phase: 'downloaded' }, config)
        log('download.complete', { httpStatus: response.statusCode, updateType: checkedPackage.type, targetVersion: checkedPackage.version })
        resolve({ tempFilePath: response.tempFilePath })
      },
      fail(error) {
        const cancelled = error && /abort/i.test(error.errMsg || '')
        reject(new UpgradeError(cancelled ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_FAILED', error.errMsg || '下载更新包失败', {
          data: error, retryable: !cancelled, phase: 'downloading'
        }))
      }
    })
    if (downloadTask && typeof downloadTask.onProgressUpdate === 'function') {
      downloadTask.onProgressUpdate(value => {
        const progress = {
          progress: value.progress,
          totalBytesWritten: value.totalBytesWritten,
          totalBytesExpectedToWrite: value.totalBytesExpectedToWrite
        }
        emit({ progress }, config)
        const bucket = Math.min(100, Math.floor(Number(value.progress || 0) / 10) * 10)
        if (bucket >= lastLoggedProgress + 10 || bucket === 100) {
          lastLoggedProgress = bucket
          log('download.progress', { progress: bucket, totalBytesWritten: value.totalBytesWritten, totalBytesExpectedToWrite: value.totalBytesExpectedToWrite })
        }
        if (typeof config.onProgress === 'function') config.onProgress(progress)
      })
    }
  }).catch(error => fail(error, config)).finally(() => {
    downloadTask = null
    activePromise = null
  })
  return activePromise
}

export async function install(localPackage, packageInfo, options = {}) {
  if (!localPackage || !localPackage.tempFilePath) {
    throw new UpgradeError('INSTALL_FAILED', '缺少待安装文件', { phase: 'installing' })
  }
  const config = resolveOptions(options)
  log('install.start', { updateType: packageInfo.type, targetVersion: packageInfo.version })
  emit({ phase: 'installing', error: null }, config)
  try {
    const result = await installPackage(localPackage.tempFilePath, packageInfo)
    log('install.success', { updateType: packageInfo.type, targetVersion: packageInfo.version, restartRequired: Boolean(result.restartRequired), awaitingRestart: Boolean(result.awaitingRestart) })
    emit({ phase: packageInfo.type === 'apk' ? 'awaiting-apk-restart' : 'restarting-wgt' }, config)
    return result
  } catch (error) {
    return fail(toUpgradeError(error, { code: 'INSTALL_FAILED', message: '安装失败', retryable: true, phase: 'installing' }), config)
  }
}

export async function checkAndUpdate(options = {}) {
  const result = await check(options)
  if (result.action === 'none' || !options.autoDownload) return result
  const localPackage = await download(result.package, options)
  return install(localPackage, result.package, options)
}

export function retry() {
  log('flow.retry', { operation: lastOperation && lastOperation.name })
  if (!lastOperation) return Promise.reject(new UpgradeError('INVALID_RESPONSE', '没有可重试的更新操作'))
  if (lastOperation.name === 'check') return check(lastOperation.options)
  return download(lastOperation.packageInfo, lastOperation.options)
    .then(localPackage => install(localPackage, lastOperation.packageInfo, lastOperation.options))
}

export function dispose() {
  log('flow.dispose', { abortingDownload: Boolean(downloadTask), active: Boolean(activePromise), listenerCount: listeners.size })
  if (downloadTask && typeof downloadTask.abort === 'function') downloadTask.abort()
  downloadTask = null
  listeners.clear()
  if (!activePromise) state = initialState()
}

export function getState() { return snapshot() }
export function shouldBlockBack() { return Boolean(state.mandatoryConfirmed) }
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export default { check, download, install, checkAndUpdate, retry, dispose, getState, shouldBlockBack, subscribe }