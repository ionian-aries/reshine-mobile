import { UpgradeError } from './errors.js'
import { parseVersion } from './contract.js'
import { log, logError } from './logger.js'

export function assertAndroidApp() {
  const hasRuntime = typeof plus !== 'undefined' && Boolean(plus.runtime)
  const osName = typeof plus !== 'undefined' && plus.os ? String(plus.os.name || '').toLowerCase() : ''
  log('runtime.inspect', { hasRuntime, osName: osName || 'unavailable' })
  if (!hasRuntime) {
    throw new UpgradeError('UNSUPPORTED_PLATFORM', '客户端更新仅支持 Android App', { phase: 'checking' })
  }
  if (!plus.os || osName !== 'android') {
    throw new UpgradeError('UNSUPPORTED_PLATFORM', '客户端更新仅支持 Android App', { phase: 'checking' })
  }
}

export function getCurrentVersions() {
  assertAndroidApp()
  return new Promise((resolve, reject) => {
    plus.runtime.getProperty(plus.runtime.appid, info => {
      try {
        const appid = (info && info.appid) || plus.runtime.appid
        const apkVersion = info && info.version
        const wgtVersion = (info && (info.versionName || info.version))
        if (!appid || !apkVersion || !wgtVersion) throw new Error('应用属性不完整')
        parseVersion(apkVersion, 'apkVersion')
        parseVersion(wgtVersion, 'wgtVersion')
        resolve({ appid, apkVersion, wgtVersion })
      } catch (error) {
        reject(new UpgradeError('VERSION_UNAVAILABLE', '无法取得当前应用版本', { data: error, phase: 'checking' }))
      }
    })
  })
}

export function installPackage(filePath, packageInfo) {
  assertAndroidApp()
  return new Promise((resolve, reject) => {
    plus.runtime.install(filePath, { force: false }, () => {
      if (packageInfo.type === 'wgt') {
        log('runtime.wgt-restart', { targetVersion: packageInfo.version })
        resolve({ restartRequired: true })
        plus.runtime.restart()
        return
      }
      resolve({ awaitingRestart: true })
    }, error => {
      const upgradeError = new UpgradeError('INSTALL_FAILED', (error && error.message) || '安装更新包失败', {
        data: error,
        retryable: true,
        phase: 'installing'
      })
      logError('runtime.install-failed', upgradeError)
      reject(upgradeError)
    })
  })
}