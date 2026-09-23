import Vue from 'vue'
import App from './App'
import AppCapabilityBridgePlugin from '@/uni_modules/app-capability-bridge'
import AppUpgradePlugin from '@/uni_modules/app-upgrade'
import './uni.promisify.adaptor'

Vue.config.productionTip = false
Vue.use(AppCapabilityBridgePlugin)
Vue.use(AppUpgradePlugin)

App.mpType = 'app'

const app = new Vue({
  ...App
})
app.$mount()
