import AppUpgrade from './components/app-upgrade/app-upgrade.vue'
import updater from './js_sdk/index.js'
import { updateNativeOverlay } from './js_sdk/native-overlay.js'
import { log, logError } from './js_sdk/logger.js'

let installed = false
let started = false
let unsubscribeOverlay = null

function startUpgradeCheck() {
  // #ifdef APP-PLUS
  if (started) {
    log('plugin.auto-check-skipped', { reason: 'already-started' })
    return
  }
  started = true
  log('plugin.auto-check-start')
  if (!unsubscribeOverlay) {
    unsubscribeOverlay = updater.subscribe(state => updateNativeOverlay(state))
  }
  updateNativeOverlay(updater.getState())
  updater.checkAndUpdate({ autoDownload: true }).then(result => {
    log('plugin.auto-check-complete', { action: result && result.action })
  }).catch(error => {
    logError('plugin.auto-check-failed', error)
  })
  // #endif
}

function install(Vue) {
  if (installed || install.installed) {
    log('plugin.install-skipped', { reason: 'already-installed' })
    return
  }
  installed = true
  install.installed = true
  Vue.component('app-upgrade', AppUpgrade)
  log('plugin.install-complete', { component: 'app-upgrade' })

  Vue.mixin({
    onLaunch() {
      if (this.$options.mpType === 'app') startUpgradeCheck()
    },
    onBackPress() {
      return Boolean(updater.shouldBlockBack())
    }
  })
}

export { AppUpgrade, install, startUpgradeCheck }
export default { install }