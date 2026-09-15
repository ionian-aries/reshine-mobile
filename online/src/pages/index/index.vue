<template>
  <view class="page">
    <web-view :src="webviewUrl" @message="handleMessage" @error="handleError"></web-view>
  </view>
</template>

<script>
const configuredUrl = process.env.VUE_APP_WEBVIEW_URL

if (!configuredUrl) {
  throw new Error('缺少 VUE_APP_WEBVIEW_URL，请配置 online/.env')
}

let parsedUrl
try {
  parsedUrl = new URL(configuredUrl)
} catch (error) {
  throw new Error('VUE_APP_WEBVIEW_URL 必须是有效绝对 URL')
}
if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
  throw new Error('VUE_APP_WEBVIEW_URL 只允许 HTTP(S) URL')
}

export default {
  data() {
    return {
      webviewUrl: parsedUrl.toString()
    }
  },
  methods: {
    handleMessage(event) {
      this.$emit('webview-message', event.detail)
    },
    handleError() {
      uni.showToast({ title: '在线页面加载失败', icon: 'none' })
    }
  }
}
</script>

<style>
.page {
  width: 100%;
  height: 100%;
}
</style>