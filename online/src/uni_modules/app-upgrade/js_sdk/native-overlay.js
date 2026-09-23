import updater from './index.js'
import { log, logError } from './logger.js'

let overlay = null
let retryable = false
let retrying = false

function runtimeAvailable() {
  return typeof plus !== 'undefined' && plus.nativeObj && typeof plus.nativeObj.View === 'function'
}

function textFor(state) {
  if (state.error) return state.error.message || '更新失败，请重试'
  if (state.phase === 'downloading') {
    const progress = state.progress && Number(state.progress.progress || 0)
    return `正在下载更新 ${progress}%`
  }
  if (state.phase === 'installing') return '正在安装更新，请稍候'
  if (state.phase === 'awaiting-apk-restart') return '请在系统安装器中完成安装，然后重新打开应用'
  return (state.packageInfo && state.packageInfo.contents) || '正在准备更新'
}

function draw(state) {
  if (!overlay) return
  const title = (state.packageInfo && state.packageInfo.title) || '客户端必须更新'
  const content = textFor(state)
  retryable = Boolean(state.phase === 'failed' && state.error && state.error.retryable)

  overlay.reset()
  overlay.drawRect({ color: 'rgba(0,0,0,0.72)' }, { top: '0px', left: '0px', width: '100%', height: '100%' })
  overlay.drawRect({ color: '#FFFFFF', radius: '12px' }, { top: '28%', left: '8%', width: '84%', height: retryable ? '270px' : '220px' })
  overlay.drawText(title, { top: '31%', left: '14%', width: '72%', height: '44px' }, {
    color: '#222222', size: '20px', weight: 'bold', align: 'center', verticalAlign: 'middle', whiteSpace: 'normal'
  })
  overlay.drawText(content, { top: '38%', left: '14%', width: '72%', height: '92px' }, {
    color: '#555555', size: '16px', align: 'center', verticalAlign: 'middle', whiteSpace: 'normal'
  })
  if (retryable) {
    overlay.drawRect({ color: '#007AFF', radius: '6px' }, { top: '51%', left: '20%', width: '60%', height: '46px' })
    overlay.drawText(retrying ? '正在重试…' : '重新尝试', { top: '51%', left: '20%', width: '60%', height: '46px' }, {
      color: '#FFFFFF', size: '17px', align: 'center', verticalAlign: 'middle'
    })
  }
  overlay.show()
}

export function updateNativeOverlay(state) {
  // #ifdef APP-PLUS
  if (!state.mandatoryConfirmed) {
    if (overlay) overlay.hide()
    return
  }
  if (!runtimeAvailable()) {
    log('overlay.unavailable', { hasPlus: typeof plus !== 'undefined' })
    return
  }
  if (!overlay) {
    overlay = new plus.nativeObj.View('app-upgrade-native-overlay', {
      top: '0px', left: '0px', width: '100%', height: '100%'
    })
    overlay.setTouchEventRect({ top: '0px', left: '0px', width: '100%', height: '100%' })
    overlay.addEventListener('click', () => {
      if (!retryable || retrying) return
      retrying = true
      draw(updater.getState())
      updater.retry().catch(error => logError('overlay.retry-failed', error)).finally(() => {
        retrying = false
        draw(updater.getState())
      })
    })
    log('overlay.created')
  }
  draw(state)
  // #endif
}

export function disposeNativeOverlay() {
  // #ifdef APP-PLUS
  if (overlay) {
    overlay.close()
    overlay = null
  }
  // #endif
}