<template>
  <view v-if="showUpgrade" class="upgrade-mask">
    <view class="upgrade-card">
      <text class="upgrade-title">{{ upgradeTitle }}</text>
      <text class="upgrade-content">{{ upgradeContent }}</text>
      <text v-if="isDownloading" class="upgrade-progress">下载进度：{{ progress }}%</text>
      <button v-if="canRetry" type="primary" @click="retry">重新尝试</button>
    </view>
  </view>
</template>

<script>
import updater from '../../js_sdk/index.js'
import { log, logError } from '../../js_sdk/logger.js'

export default {
  name: 'AppUpgrade',
  props: {
    autoStart: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      upgradeState: updater.getState(),
      unsubscribeUpgrade: null
    }
  },
  computed: {
    showUpgrade() {
      return Boolean(this.upgradeState.mandatoryConfirmed)
    },
    isDownloading() {
      return this.upgradeState.phase === 'downloading'
    },
    progress() {
      return (this.upgradeState.progress && this.upgradeState.progress.progress) || 0
    },
    canRetry() {
      return this.upgradeState.phase === 'failed' && this.upgradeState.error && this.upgradeState.error.retryable
    },
    upgradeTitle() {
      return (this.upgradeState.packageInfo && this.upgradeState.packageInfo.title) || '正在更新客户端'
    },
    upgradeContent() {
      if (this.upgradeState.error) return this.upgradeState.error.message
      if (this.upgradeState.phase === 'installing') return '正在安装更新，请稍候'
      if (this.upgradeState.phase === 'awaiting-apk-restart') return '请在系统安装器中完成安装，然后重新打开应用'
      return (this.upgradeState.packageInfo && this.upgradeState.packageInfo.contents) || '正在检查更新'
    }
  },
  mounted() {
    log('component.mounted', { autoStart: this.autoStart })
    this.unsubscribeUpgrade = updater.subscribe(state => {
      this.upgradeState = state
    })
    if (this.autoStart) this.start()
  },
  beforeDestroy() {
    log('component.destroy', { subscribed: Boolean(this.unsubscribeUpgrade) })
    if (this.unsubscribeUpgrade) this.unsubscribeUpgrade()
  },
  methods: {
    start(options = {}) {
      // #ifdef APP-PLUS
      return updater.checkAndUpdate({ autoDownload: true, ...options }).catch(error => {
        logError('component.start-failed', error)
        if (!this.upgradeState.mandatoryConfirmed && error.code !== 'UNSUPPORTED_PLATFORM') {
          uni.showToast({ title: '更新检查失败，稍后将重试', icon: 'none' })
        }
        return undefined
      })
      // #endif
      // #ifndef APP-PLUS
      return Promise.resolve({ action: 'unsupported' })
      // #endif
    },
    retry() {
      // #ifdef APP-PLUS
      return updater.retry().catch(error => {
        logError('component.retry-failed', error)
        return undefined
      })
      // #endif
      // #ifndef APP-PLUS
      return Promise.resolve({ action: 'unsupported' })
      // #endif
    }
  }
}
</script>

<style>
.upgrade-mask {
  position: fixed;
  z-index: 9999;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48rpx;
  background: rgba(0, 0, 0, 0.65);
}

.upgrade-card {
  width: 100%;
  padding: 48rpx;
  border-radius: 20rpx;
  background: #ffffff;
}

.upgrade-title,
.upgrade-content,
.upgrade-progress {
  display: block;
  margin-bottom: 28rpx;
}

.upgrade-title {
  font-size: 36rpx;
  font-weight: 600;
}

.upgrade-content,
.upgrade-progress {
  color: #555555;
  font-size: 28rpx;
  line-height: 1.6;
}
</style>