<template>
  <app-capability-bridge-shell
    :src="webviewUrl"
    :bridge-options="{ debugLogging: debugBridge }"
    @error="handleError"
  />
</template>

<script>
const webviewUrl = (process.env.VUE_APP_WEBVIEW_URL || '').trim()
if (!webviewUrl) throw new Error('缺少 VUE_APP_WEBVIEW_URL，请配置 online/.env')

export default {
  data: () => ({ webviewUrl, debugBridge: process.env.NODE_ENV !== 'production' }),
  methods: {
    handleError() { uni.showToast({ title: '在线页面或桥接加载失败', icon: 'none' }) }
  }
}
</script>