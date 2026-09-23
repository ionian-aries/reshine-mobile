<template>
  <view class="test-page">
    <text class="title">客户端更新联调</text>
    <text class="description">应用启动后会自动检查更新。当前页面仅用于确认业务页面未被阻塞。</text>
  </view>
</template>

<script>
export default {
  name: 'UpgradeTestPage'
}
</script>

<style>
.test-page {
  padding: 96rpx 48rpx;
}

.title,
.description {
  display: block;
}

.title {
  margin-bottom: 32rpx;
  font-size: 40rpx;
  font-weight: 600;
}

.description {
  color: #666666;
  font-size: 28rpx;
  line-height: 1.7;
}
</style>