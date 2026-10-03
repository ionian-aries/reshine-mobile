import { UpgradeError } from './errors.js'

const APP_INFO_TIMEOUT_MS = 15000
const DELETE_TIMEOUT_MS = 5000
const DOWNLOAD_TIMEOUT_MS = 120000
const INSTALL_TIMEOUT_MS = 60000
const UPDATE_DIR = '_doc/update/'
const PENDING_WGT_KEY = 'app-upgrade:pending-wgt'
const MAX_RESTART_ATTEMPTS = 2
const MAX_INSTALL_ATTEMPTS = 2

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function projectAppid() {
  if (typeof __uniConfig === 'undefined') return ''
  return (__uniConfig.appid || (__uniConfig.app && __uniConfig.app.appid) || '')
}

export function isAndroidApp() {
  return typeof plus !== 'undefined' && Boolean(plus.runtime) && Boolean(plus.os) && String(plus.os.name || '').toLowerCase() === 'android'
}

export function assertAndroidApp() {
  if (!isAndroidApp()) throw new UpgradeError('UNSUPPORTED_PLATFORM', '客户端更新仅支持 Android App', { phase: 'checking' })
}

function resolveEntry(path) {
  return new Promise((resolve, reject) => plus.io.resolveLocalFileSystemURL(path, resolve, reject))
}

function getDirectory(parent, name, create) {
  return new Promise((resolve, reject) => parent.getDirectory(name, { create }, resolve, reject))
}

function readEntries(directory) {
  return new Promise((resolve, reject) => directory.createReader().readEntries(resolve, reject))
}

function removeEntry(entry) {
  return new Promise((resolve, reject) => {
    const method = entry.isDirectory && typeof entry.removeRecursively === 'function' ? 'removeRecursively' : 'remove'
    entry[method](resolve, reject)
  })
}

export async function clearUpdateDirectory() {
  assertAndroidApp()
  if (!plus.io || typeof plus.io.resolveLocalFileSystemURL !== 'function') {
    throw new UpgradeError('CLEANUP_FAILED', '更新目录能力不可用', { retryable: true, phase: 'cleaning' })
  }
  try {
    const doc = await resolveEntry('_doc/')
    const directory = await getDirectory(doc, 'update', true)
    const entries = await readEntries(directory)
    await Promise.all(entries.map(removeEntry))
    const remaining = await readEntries(directory)
    if (remaining.length) throw new Error('更新目录复查不为空')
  } catch (error) {
    throw new UpgradeError('CLEANUP_FAILED', '清理更新目录失败', { data: error, retryable: true, phase: 'cleaning' })
  }
}

export function deletePackage(filePath) {
  if (!filePath || !plus.io) return Promise.resolve(false)
  return resolveEntry(filePath).then(removeEntry).then(() => true).catch(error => {
    return false
  })
}

export async function deletePackageWithTimeout(filePath, timeout = DELETE_TIMEOUT_MS) {
  return Promise.race([
    deletePackage(filePath),
    new Promise(resolve => setTimeout(() => resolve(false), timeout))
  ])
}

function readProperty(appid) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('获取应用信息超时')), APP_INFO_TIMEOUT_MS)
    try {
      // 5+ Runtime 官方签名只有 appid 和 successCallback 两个参数。
      plus.runtime.getProperty(appid, value => finish(resolve, value))
    } catch (error) {
      finish(reject, error)
    }
  })
}

export async function getAppInfo() {
  try {
    assertAndroidApp()
    const appid = projectAppid() || plus.runtime.appid
    if (!nonEmpty(appid) || !nonEmpty(plus.runtime.version)) throw new Error('appid 或 APK 版本不可用')
    const info = await readProperty(appid)
    if (!nonEmpty(info && info.version)) throw new Error('WGT 版本不可用')
    return { status: 'success', code: 'OK', message: '', data: {
      appid,
      apkVersion: plus.runtime.version,
      wgtVersion: info.version,
      wgtVersionCode: present(info.versionCode) ? info.versionCode : ''
    } }
  } catch (error) {
    return {
      status: 'error', code: error instanceof UpgradeError ? error.code : 'VERSION_UNAVAILABLE',
      message: '当前应用版本信息不可用', data: { appid: '', apkVersion: '', wgtVersion: '', wgtVersionCode: '' }
    }
  }
}

export function getPendingWgt() {
  try { return typeof uni !== 'undefined' && uni.getStorageSync ? uni.getStorageSync(PENDING_WGT_KEY) || null : null } catch (error) { return null }
}

export function savePendingWgt(value) {
  if (typeof uni === 'undefined' || typeof uni.setStorageSync !== 'function') {
    throw new UpgradeError('PENDING_WGT_SAVE_FAILED', '无法持久化 WGT 更新状态', { data: value, retryable: true, phase: 'installing' })
  }
  const previous = getPendingWgt() || {}
  const next = {
    ...previous,
    ...value,
    attemptId: value.attemptId || previous.attemptId || `wgt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sequence: Number(previous.sequence || 0) + 1,
    updatedAt: Date.now()
  }
  uni.setStorageSync(PENDING_WGT_KEY, next)
  return next
}

export function clearPendingWgt() {
  try { if (typeof uni !== 'undefined' && typeof uni.removeStorageSync === 'function') uni.removeStorageSync(PENDING_WGT_KEY) } catch (error) {}
}

export async function inspectLocalPackage(filePath) {
  assertAndroidApp()
  if (!nonEmpty(filePath) || !plus.io || typeof plus.io.resolveLocalFileSystemURL !== 'function') {
    throw new UpgradeError('WGT_FILE_UNAVAILABLE', 'WGT 更新包本地路径不可用', {
      data: { filePath: filePath || null }, retryable: true, phase: 'installing'
    })
  }
  try {
    const entry = await resolveEntry(filePath)
    const metadata = await new Promise(resolve => {
      if (!entry || typeof entry.getMetadata !== 'function') return resolve({})
      entry.getMetadata(value => resolve(value || {}), () => resolve({}))
    })
    const fullPath = entry && (entry.fullPath || (typeof entry.toLocalURL === 'function' ? entry.toLocalURL() : ''))
    const size = Number(metadata.size) || 0
    if (!entry || entry.isDirectory || (metadata.size != null && size <= 0)) throw new Error('WGT 文件不存在、为空或不是普通文件')
    const result = { sourcePath: filePath, fullPath: fullPath || '', size, isFile: !entry.isDirectory }
    return result
  } catch (error) {
    if (error instanceof UpgradeError) {
      throw error
    }
    const failure = new UpgradeError('WGT_FILE_UNAVAILABLE', error.message || 'WGT 更新包本地文件不可用', {
      data: { filePath }, retryable: true, phase: 'installing'
    })
    throw failure
  }
}

export async function validatePendingWgt(current) {
  const pending = getPendingWgt()
  if (!pending) return { status: 'none' }
  const expected = pending.expected || { appid: pending.appid, version: pending.version, versionCode: pending.versionCode }
  const versionMatches = expected.version === current.wgtVersion
  const codeMatches = !present(expected.versionCode) || String(expected.versionCode) === String(current.wgtVersionCode)
  const appMatches = expected.appid === current.appid
  if (appMatches && versionMatches && codeMatches) {
    if (pending.sourcePath) {
      const deleted = await deletePackage(pending.sourcePath)
      void deleted
    }
    clearPendingWgt()
    return { status: 'verified', pending }
  }
  if (pending.stage === 'downloaded') return { status: 'resume-install', pending, expected }
  if (pending.stage === 'install-requested') {
    const attempts = Number(pending.installAttempts || 1)
    if (attempts < MAX_INSTALL_ATTEMPTS) {
      return { status: 'resume-install', pending, expected, interrupted: true }
    }
  }
  if (pending.stage === 'installed') return { status: 'resume-restart', pending, expected }
  if (pending.stage === 'restart-requested') {
    const currentProcessId = typeof plus !== 'undefined' && plus.runtime ? plus.runtime.processId : null
    const currentStartupTime = typeof plus !== 'undefined' && plus.runtime ? plus.runtime.startupTime : null
    const processChanged = present(pending.processId) && present(currentProcessId) && String(pending.processId) !== String(currentProcessId)
    const startupChanged = present(pending.startupTime) && present(currentStartupTime) && String(pending.startupTime) !== String(currentStartupTime)
    const attempts = Number(pending.restartAttempts || 1)
    if (attempts < MAX_RESTART_ATTEMPTS) {
      return { status: 'resume-restart', pending, expected, processChanged, startupChanged }
    }
  }
  const interruptedInstall = pending.stage === 'install-requested'
  throw new UpgradeError(interruptedInstall ? 'WGT_INSTALL_INTERRUPTED' : 'WGT_ACTIVATION_FAILED', interruptedInstall
    ? 'WGT 安装期间应用异常结束，已停止自动重试'
    : 'WGT 资源未生效，已停止自动安装和重启', {
    data: { pending, expected, current, installedWidgetInfo: pending.installedWidgetInfo || null }, retryable: true, phase: 'verifying-wgt'
  })
}

export function requestRuntimeRestart(pending = {}) {
  const next = savePendingWgt({
    ...pending,
    stage: 'restart-requested',
    restartAttempts: Number(pending.restartAttempts || 0) + 1,
    restartRequestedAt: Date.now()
  })
  try {
    plus.runtime.restart()
    return next
  } catch (error) {
    throw new UpgradeError('RESTART_FAILED', error.message || '请求重启应用失败', {
      data: { pending: next }, retryable: true, phase: 'restarting-wgt'
    })
  }
}

export function downloadPackage(url, type, onProgress, timeout = DOWNLOAD_TIMEOUT_MS) {
  assertAndroidApp()
  const targetPath = type === 'wgt' ? UPDATE_DIR : `${UPDATE_DIR}update.${type}`
  return new Promise((resolve, reject) => {
    let task
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      if (task && typeof task.abort === 'function') task.abort()
      deletePackage(targetPath)
      finish(reject, new UpgradeError('DOWNLOAD_TIMEOUT', '更新包下载超时', { retryable: true, phase: 'downloading' }))
    }, timeout)
    try {
      task = plus.downloader.createDownload(url, { filename: targetPath }, (completedTask, status) => {
        const finalTask = completedTask || task
        const httpStatus = Number(status || (finalTask && finalTask.status))
        const localPath = finalTask && (finalTask.filename || finalTask.fileName)
        if (!finalTask || Number(finalTask.state) !== 4 || httpStatus < 200 || httpStatus >= 300 || !nonEmpty(localPath)) {
          if (task && typeof task.abort === 'function') task.abort()
          deletePackage(targetPath)
          finish(reject, new UpgradeError('DOWNLOAD_FAILED', '更新包下载结果不可用', { data: { httpStatus }, retryable: true, phase: 'downloading' }))
          return
        }
        finish(resolve, { filePath: localPath, targetPath, httpStatus, totalBytes: Number(finalTask.totalSize || finalTask.downloadedSize) || 0 })
      })
      if (!task) throw new Error('下载任务创建失败')
      if (typeof task.addEventListener === 'function') task.addEventListener('statechanged', current => {
        if (current && Number(current.state) === 3 && typeof onProgress === 'function') {
          const total = Number(current.totalSize) || 0
          const written = Number(current.downloadedSize) || 0
          onProgress({ progress: total > 0 ? Math.min(100, Math.floor(written * 100 / total)) : 0, totalBytesWritten: written, totalBytesExpectedToWrite: total })
        }
      })
      task.start()
    } catch (error) {
      deletePackage(targetPath)
      finish(reject, new UpgradeError('DOWNLOAD_FAILED', error.message || '创建下载任务失败', { data: error, retryable: true, phase: 'downloading' }))
    }
  })
}

export function validateInstalledWidgetInfo(result, expected = {}) {
  const actual = result && typeof result === 'object' ? result : {}
  const checks = [
    ['appid', actual.appid || actual.id, expected.appid],
    ['version', actual.version, expected.version],
    ['versionCode', actual.versionCode, expected.versionCode]
  ]
  const mismatches = checks
    .filter(([, value, wanted]) => present(value) && present(wanted) && String(value) !== String(wanted))
    .map(([field, value, wanted]) => ({ field, actual: value, expected: wanted }))
  if (mismatches.length) {
    throw new UpgradeError('WGT_INFO_MISMATCH', 'WGT 安装回调返回的应用信息与目标版本不一致', {
      data: { widgetInfo: result || null, expected, mismatches }, retryable: true, phase: 'installing'
    })
  }
  return result
}

export function installWgt(filePath, expected = {}, context = {}, timeout = INSTALL_TIMEOUT_MS) {
  assertAndroidApp()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      const error = new UpgradeError('INSTALL_TIMEOUT', '安装 WGT 更新包超时', {
        data: { packageType: 'wgt', filePath, attemptId: context.attemptId || null }, retryable: true, phase: 'installing'
      })
      finish(reject, error)
    }, timeout)
    try {
      plus.runtime.install(filePath, { force: false }, result => {
        try { finish(resolve, validateInstalledWidgetInfo(result, expected)) } catch (error) { finish(reject, error) }
      }, runtimeError => {
        const error = new UpgradeError('INSTALL_FAILED', (runtimeError && (runtimeError.message || runtimeError.errMsg)) || '安装 WGT 更新包失败', {
          data: { packageType: 'wgt', filePath, runtimeInstall: runtimeError || null }, retryable: true, phase: 'installing'
        })
        finish(reject, error)
      })
    } catch (runtimeError) {
      const error = new UpgradeError('INSTALL_FAILED', runtimeError.message || '安装 WGT 更新包失败', {
        data: { packageType: 'wgt', filePath, runtimeInstall: runtimeError }, retryable: true, phase: 'installing'
      })
      finish(reject, error)
    }
  })
}

export function openApkUrl(url, onError) {
  assertAndroidApp()
  try {
    plus.runtime.openURL(url, onError)
    return { opened: true }
  } catch (error) {
    throw new UpgradeError('OPEN_URL_FAILED', error.message || '打开 APK 下载地址失败', {
      data: { packageType: 'apk' }, retryable: true, phase: 'opening-apk'
    })
  }
}