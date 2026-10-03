import updater from './js_sdk/index.js'
import { disposeNativeOverlay, updateNativeOverlay } from './js_sdk/native-overlay.js'

let installed = false
let started = false
let unsubscribeOverlay = null

function startUpgradeCheck() {
  // #ifdef APP-PLUS
  if (started) {
    return
  }
  started = true
  unsubscribeOverlay = updater.subscribe(state => updateNativeOverlay(state))
  updateNativeOverlay(updater.getState())
  updater.checkAndUpdate().catch(() => {})
  // #endif
}

function stopUpgradeCheck() {
  // #ifdef APP-PLUS
  if (unsubscribeOverlay) unsubscribeOverlay()
  unsubscribeOverlay = null
  disposeNativeOverlay()
  updater.dispose()
  started = false
  // #endif
}

function install(Vue) {
  if (installed || install.installed) {
    return
  }
  installed = true
  install.installed = true

  Vue.mixin({
    onLaunch() {
      if (this.$options.mpType !== 'app') return
      // #ifdef APP-PLUS
      if (typeof plus !== 'undefined') startUpgradeCheck()
      else if (typeof document !== 'undefined') document.addEventListener('plusready', startUpgradeCheck, { once: true })
      // #endif
    },
    onBackPress() {
      return Boolean(updater.shouldBlockBack())
    }
  })
}

export { install, startUpgradeCheck, stopUpgradeCheck }
export default { install }