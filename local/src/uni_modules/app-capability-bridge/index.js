import AppCapabilityBridgeShell from './components/app-capability-bridge-shell/app-capability-bridge-shell.vue'

export function install(Vue) {
  if (!Vue || typeof Vue.component !== 'function' || install.installed) return
  Vue.component('app-capability-bridge-shell', AppCapabilityBridgeShell)
  install.installed = true
}

export { AppCapabilityBridgeShell }
export default { install }