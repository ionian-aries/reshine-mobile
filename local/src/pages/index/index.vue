<template>
  <view class="page">
    <web-view :src="webviewUrl" @message="handleMessage" @error="handleError"></web-view>
  </view>
</template>

<script>
export default {
  data() {
    return {
      webviewUrl: '/hybrid/html/index.html#/index'
    }
  },
  methods: {
    handleMessage(event) {
      this.$emit('webview-message', event.detail)
    },
    handleError() {
      uni.showToast({ title: '本地页面加载失败', icon: 'none' })
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