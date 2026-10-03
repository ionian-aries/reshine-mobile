<template>
  <view class="version-page">
    <view class="version-card">
      <text class="eyebrow">wgt VERSION TEST</text>
      <text class="version">1.0.1</text>
      <text class="status">版本测试页面</text>
    </view>
  </view>
</template>

<style scoped>
.version-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 48rpx;
  box-sizing: border-box;
  background: #f4f7fb;
}

.version-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 96rpx 40rpx;
  border: 2rpx solid #dce4ef;
  border-radius: 32rpx;
  box-sizing: border-box;
  background: #ffffff;
  box-shadow: 0 20rpx 60rpx rgba(31, 55, 85, 0.1);
}

.eyebrow {
  color: #607086;
  font-size: 24rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
}

.version {
  margin-top: 28rpx;
  color: #10233f;
  font-size: 112rpx;
  font-weight: 700;
  line-height: 1;
}

.status {
  margin-top: 32rpx;
  color: #2f6fed;
  font-size: 30rpx;
  font-weight: 600;
}
</style>
