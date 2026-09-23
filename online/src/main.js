import Vue from 'vue'
import App from './App'
import AppCapabilityBridgePlugin from '@/uni_modules/app-capability-bridge'
import './uni.promisify.adaptor'

Vue.config.productionTip = false
Vue.use(AppCapabilityBridgePlugin)

App.mpType = 'app'

const app = new Vue({
  ...App
})
app.$mount()
