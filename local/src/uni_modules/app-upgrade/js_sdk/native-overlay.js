import updater from './index.js'
import { formatErrorDetails } from './errors.js'

let overlay = null
let overlayVisible = false
let actionBounds = null
let copyBounds = null
let acting = false
let copyFeedback = ''
let runtimeHandlers = null

function runtimeAvailable() {
  return typeof plus !== 'undefined' && plus.nativeObj && typeof plus.nativeObj.View === 'function'
}

function screenSize() {
  const width = Number(plus.screen && plus.screen.resolutionWidth) || 360
  const height = Number(plus.screen && plus.screen.resolutionHeight) || 720
  return { width: Math.max(240, width), height: Math.max(320, height) }
}

function px(value) {
  return `${Math.round(value)}px`
}

function actionFor(state) {
  if (state.phase === 'update-available') return { label: acting ? '正在处理…' : '立即更新', run: () => updater.confirmUpdate() }
  if (state.phase === 'failed' && state.error && state.error.retryable) return { label: acting ? '正在重试…' : '重新尝试', run: () => updater.retry() }
  return null
}

function contentFor(state) {
  if (state.error) return formatErrorDetails(state.error)
  if (state.phase === 'downloading') return `正在下载更新 ${Number(state.progress && state.progress.progress || 0)}%`
  if (state.phase === 'installing') return '正在安装更新，请稍候'
  if (state.phase === 'opening-apk') return '正在打开系统浏览器，请稍候'
  if (state.phase === 'apk-url-opened') return '已打开下载地址，请在浏览器中完成更新'
  if (state.phase === 'verifying-wgt' || state.phase === 'checking-runtime') return '正在验证已安装的资源版本'
  return (state.packageInfo && state.packageInfo.contents) || '正在准备更新'
}

function fitText(value, maxLines, charsPerLine) {
  const text = String(value || '')
  const maxLength = Math.max(1, maxLines * charsPerLine)
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text
}

function draw(state) {
  if (!overlay) return
  const size = screenSize()
  const horizontalMargin = Math.max(16, Math.round(size.width * 0.08))
  const cardLeft = horizontalMargin
  const cardWidth = size.width - horizontalMargin * 2
  const cardHeight = state.error ? Math.max(304, size.height - 16) : Math.min(390, Math.max(250, size.height - 48))
  const cardTop = state.error ? 8 : Math.max(24, Math.round((size.height - cardHeight) / 2))
  const padding = Math.min(24, Math.max(16, Math.round(cardWidth * 0.07)))
  const buttonHeight = 48
  const buttonBottom = 22
  const hasError = Boolean(state.error)
  const copyHeight = hasError ? 42 : 0
  const copyGap = hasError ? 10 : 0
  const buttonTop = cardTop + cardHeight - buttonBottom - buttonHeight
  const copyTop = buttonTop - copyGap - copyHeight
  const packageInfo = state.packageInfo || {}
  const currentVersion = packageInfo.type === 'apk'
    ? state.current && state.current.apkVersion
    : state.current && state.current.wgtVersion
  const action = actionFor(state)
  actionBounds = action ? { left: cardLeft + padding, top: buttonTop, width: cardWidth - padding * 2, height: buttonHeight } : null
  copyBounds = hasError ? { left: cardLeft + padding, top: copyTop, width: cardWidth - padding * 2, height: copyHeight } : null
  const charsPerLine = Math.max(12, Math.floor((cardWidth - padding * 2) / 15))
  const contentBottom = copyBounds ? copyTop : buttonTop
  const contentHeight = Math.max(54, contentBottom - (cardTop + 138) - 12)
  const contentLines = Math.max(2, Math.floor(contentHeight / 22) - 1)

  if (typeof overlay.setStyle === 'function') overlay.setStyle({ top: '0px', left: '0px', width: '100%', height: '100%' })
  overlay.setTouchEventRect({ top: '0px', left: '0px', width: '100%', height: '100%' })
  // 使用固定绘制 ID 原位替换元素。reset() 会先清空原生画布，在随后多次
  // draw* 提交完成前产生透明帧，下载进度频繁更新时就会闪烁并露出 WebView。
  overlay.drawRect({ color: '#F3F6FA' }, { top: '0px', left: '0px', width: '100%', height: '100%' }, 'upgrade-background')
  overlay.drawRect({ color: '#FFFFFF', radius: '12px' }, { top: px(cardTop), left: px(cardLeft), width: px(cardWidth), height: px(cardHeight) }, 'upgrade-card')
  overlay.drawText(fitText(packageInfo.title || '客户端必须更新', 2, charsPerLine), { top: px(cardTop + 18), left: px(cardLeft + padding), width: px(cardWidth - padding * 2), height: '48px' }, {
    color: '#222222', size: '20px', weight: 'bold', align: 'center', verticalAlign: 'middle', whiteSpace: 'normal', overflow: 'ellipsis'
  }, 'upgrade-title')
  overlay.drawText(`当前版本：${currentVersion || '-'}\n目标版本：${packageInfo.version || '-'}  包类型：${String(packageInfo.type || '-').toUpperCase()}`, {
    top: px(cardTop + 70), left: px(cardLeft + padding), width: px(cardWidth - padding * 2), height: '62px'
  }, { color: '#666666', size: '14px', align: 'left', verticalAlign: 'middle', whiteSpace: 'normal', overflow: 'ellipsis' }, 'upgrade-version')
  const content = contentFor(state)
  const renderedContent = state.error ? content : fitText(content, contentLines, charsPerLine)
  overlay.drawText(`更新内容\n${renderedContent}`, {
    top: px(cardTop + 138), left: px(cardLeft + padding), width: px(cardWidth - padding * 2), height: px(contentHeight)
  }, { color: '#444444', size: '15px', align: 'left', verticalAlign: 'top', whiteSpace: 'normal', overflow: 'ellipsis' }, 'upgrade-content')
  const hiddenBounds = { top: '0px', left: '0px', width: '0px', height: '0px' }
  const copyRect = copyBounds ? { top: px(copyBounds.top), left: px(copyBounds.left), width: px(copyBounds.width), height: px(copyBounds.height) } : hiddenBounds
  overlay.drawRect({ color: copyBounds ? '#EEF5FF' : '#F3F6FA', borderColor: copyBounds ? '#007AFF' : '#F3F6FA', borderWidth: copyBounds ? '1px' : '0px', radius: '6px' }, copyRect, 'upgrade-copy-button')
  overlay.drawText(copyBounds ? (copyFeedback || '复制错误信息') : '', copyRect, { color: '#007AFF', size: '15px', align: 'center', verticalAlign: 'middle' }, 'upgrade-copy-label')
  const actionRect = actionBounds ? { top: px(actionBounds.top), left: px(actionBounds.left), width: px(actionBounds.width), height: px(actionBounds.height) } : hiddenBounds
  overlay.drawRect({ color: action ? (acting ? '#8CB8E8' : '#007AFF') : '#F3F6FA', radius: '6px' }, actionRect, 'upgrade-action-button')
  overlay.drawText(action ? action.label : '', actionRect, { color: '#FFFFFF', size: '17px', align: 'center', verticalAlign: 'middle' }, 'upgrade-action-label')
  if (!overlayVisible) {
    overlay.show()
    overlayVisible = true
  }
}

function inside(bounds, event) {
  if (!bounds) return false
  const x = Number(event && (event.clientX != null ? event.clientX : (event.screenX != null ? event.screenX : event.x)))
  const y = Number(event && (event.clientY != null ? event.clientY : (event.screenY != null ? event.screenY : event.y)))
  return Number.isFinite(x) && Number.isFinite(y) && x >= bounds.left && x <= bounds.left + bounds.width && y >= bounds.top && y <= bounds.top + bounds.height
}

function copyError(state) {
  if (!state.error || typeof uni === 'undefined' || typeof uni.setClipboardData !== 'function') return
  uni.setClipboardData({
    data: formatErrorDetails(state.error),
    success() { copyFeedback = '已复制错误信息'; draw(updater.getState()) },
    fail() { copyFeedback = '复制失败，请重试'; draw(updater.getState()) }
  })
}

function keepOnTop() {
  if (!overlay) return
  if (typeof overlay.setStyle === 'function') overlay.setStyle({ top: '0px', left: '0px', width: '100%', height: '100%' })
  if (typeof overlay.show === 'function') overlay.show()
  overlayVisible = true
}

function listenForRuntimeChanges() {
  if (runtimeHandlers || !plus.globalEvent || typeof plus.globalEvent.addEventListener !== 'function') return
  const redraw = () => draw(updater.getState())
  const resume = () => {
    if (!updater.getState().mandatoryConfirmed) return
    draw(updater.getState())
    keepOnTop()
  }
  runtimeHandlers = { orientationchange: redraw, resize: redraw, resume }
  Object.keys(runtimeHandlers).forEach(name => plus.globalEvent.addEventListener(name, runtimeHandlers[name]))
}

function stopListeningForRuntimeChanges() {
  if (!runtimeHandlers) return
  if (typeof plus !== 'undefined' && plus.globalEvent && typeof plus.globalEvent.removeEventListener === 'function') {
    Object.keys(runtimeHandlers).forEach(name => plus.globalEvent.removeEventListener(name, runtimeHandlers[name]))
  }
  runtimeHandlers = null
}

export function updateNativeOverlay(state) {
  // #ifdef APP-PLUS
  if (!state.mandatoryConfirmed) {
    if (overlay && overlayVisible) overlay.hide()
    overlayVisible = false
    return
  }
  if (!runtimeAvailable()) {
    return
  }
  if (!overlay) {
    overlay = new plus.nativeObj.View('app-upgrade-native-overlay', { top: '0px', left: '0px', width: '100%', height: '100%' })
    overlay.addEventListener('click', event => {
      const current = updater.getState()
      if (inside(copyBounds, event)) {
        copyError(current)
        return
      }
      if (acting || !inside(actionBounds, event)) return
      const action = actionFor(current)
      if (!action) return
      acting = true
      draw(updater.getState())
      action.run().catch(() => {}).finally(() => {
        acting = false
        draw(updater.getState())
      })
    })
    listenForRuntimeChanges()
  }
  draw(state)
  // #endif
}

export function disposeNativeOverlay() {
  // #ifdef APP-PLUS
  stopListeningForRuntimeChanges()
  if (overlay) overlay.close()
  overlay = null
  overlayVisible = false
  actionBounds = null
  copyBounds = null
  copyFeedback = ''
  acting = false
  // #endif
}