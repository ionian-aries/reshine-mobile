import { validateMessage } from './contract/validation.js'

export function resolveStatusBarHeight(plusRuntime, uniRuntime) {
  try {
    const navigator = plusRuntime && plusRuntime.navigator
    if (navigator && typeof navigator.isImmersedStatusbar === 'function' && !navigator.isImmersedStatusbar()) return 0
    if (navigator && typeof navigator.getStatusbarHeight === 'function') {
      const height = Number(navigator.getStatusbarHeight())
      if (Number.isFinite(height) && height >= 0) return height
    }
  } catch (_) {}
  try {
    const info = uniRuntime && typeof uniRuntime.getSystemInfoSync === 'function' ? uniRuntime.getSystemInfoSync() : null
    const height = Number(info && info.statusBarHeight)
    return Number.isFinite(height) && height >= 0 ? height : 0
  } catch (_) { return 0 }
}

export function configureStatusBar(plusRuntime, backgroundColor = '#00000000', style = 'dark') {
  try {
    const navigator = plusRuntime && plusRuntime.navigator
    if (!navigator) return false
    if (typeof navigator.setStatusBarBackground === 'function') navigator.setStatusBarBackground(backgroundColor)
    if (typeof navigator.setStatusBarStyle === 'function') navigator.setStatusBarStyle(style)
    return true
  } catch (_) { return false }
}

export function parseBridgeSource(value) {
  const src = typeof value === 'string' ? value.trim() : ''
  if (!src) throw new Error('app-capability-bridge-shell 的 src 不能为空')
  const remote = /^https?:\/\//i.test(src)
  return Object.freeze({ src, kind: remote ? 'remote' : 'local', origin: remote ? src.match(/^https?:\/\/[^/]+/i)[0] : null })
}

function stringValue(value) { return typeof value === 'string' ? value.trim() : '' }
export function getNativeWebViewId(webview) {
  if (!webview) return ''
  if (stringValue(webview.id)) return stringValue(webview.id)
  try { const style = typeof webview.getStyle === 'function' && webview.getStyle(); return stringValue(style && style.id) } catch (_) { return '' }
}
export function getNativeWebViewUrl(webview) {
  if (!webview) return ''
  try {
    if (typeof webview.getURL === 'function') {
      const url = stringValue(webview.getURL())
      if (url) return url
    }
  } catch (_) {}
  if (stringValue(webview.url)) return stringValue(webview.url)
  if (stringValue(webview.src)) return stringValue(webview.src)
  try { const style = typeof webview.getStyle === 'function' && webview.getStyle(); return stringValue(style && (style.url || style.src)) } catch (_) { return '' }
}

// `$getAppWebview` belongs to a uni-app page instance. A globally registered
// child component's `$scope` is not guaranteed to be that page, so recover the
// current page explicitly before inspecting its native children.
export function getPageWebView(componentScope, getPages, plusRuntime) {
  const resolve = candidate => {
    try { return candidate && typeof candidate.$getAppWebview === 'function' ? candidate.$getAppWebview() : null } catch (_) { return null }
  }
  const scoped = resolve(componentScope)
  if (scoped) return scoped
  try {
    const pages = typeof getPages === 'function' ? getPages() : []
    const page = Array.isArray(pages) && pages.length ? pages[pages.length - 1] : null
    const fromPage = resolve(page) || resolve(page && page.$vm) || resolve(page && page.$vm && page.$vm.$scope)
    if (fromPage) return fromPage
  } catch (_) {}
  try { return plusRuntime && plusRuntime.webview && typeof plusRuntime.webview.currentWebview === 'function' ? plusRuntime.webview.currentWebview() : null } catch (_) { return null }
}

function safeChildren(webview) {
  try { const children = webview && typeof webview.children === 'function' ? webview.children() : []; return Array.isArray(children) ? children : [] } catch (_) { return [] }
}
function sameWebView(left, right) { return left === right || (!!getNativeWebViewId(left) && getNativeWebViewId(left) === getNativeWebViewId(right)) }
export function getOwnedWebViewCandidates(pageWebview, plusRuntime) {
  const direct = safeChildren(pageWebview)
  if (direct.length) return direct
  // Some App-vue runtimes omit `<web-view>` objects from children() while the
  // HTML5+ object still exposes parent(). Use all() only with explicit parent
  // ownership; never select an unrelated global WebView.
  try {
    const all = plusRuntime && plusRuntime.webview && typeof plusRuntime.webview.all === 'function' ? plusRuntime.webview.all() : []
    return (Array.isArray(all) ? all : []).filter(candidate => {
      if (!candidate || sameWebView(candidate, pageWebview) || typeof candidate.parent !== 'function') return false
      try { return sameWebView(candidate.parent(), pageWebview) } catch (_) { return false }
    })
  } catch (_) { return [] }
}
export function normalizeWebViewUrl(value) {
  const source = stringValue(value)
  if (!source) return ''
  if (/^https?:\/\//i.test(source)) {
    try {
      const parsed = new URL(source)
      parsed.protocol = parsed.protocol.toLowerCase(); parsed.hostname = parsed.hostname.toLowerCase()
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = ''
      return parsed.href.replace(/\/$/, '')
    } catch (_) { return source.replace(/\/$/, '') }
  }
  return source.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^.*\/(?:_www|www)\//i, '/').replace(/^\.?\//, '/').replace(/\/{2,}/g, '/')
}
function matchesSource(actual, expected) {
  const left = normalizeWebViewUrl(actual); const right = normalizeWebViewUrl(expected)
  if (!left || !right) return false
  if (/^https?:\/\//i.test(right)) return left === right
  return left === right || left.endsWith(right) || left.split('#')[0].endsWith(right.split('#')[0])
}
export function inspectWebViewCandidates(children, expectedSource) {
  const candidates = (Array.isArray(children) ? children : []).filter(child => child && typeof child.evalJS === 'function')
  const matched = expectedSource ? candidates.filter(child => matchesSource(getNativeWebViewUrl(child), expectedSource)) : []
  return { candidates, matched }
}
export function resolveWebViewCandidate(children, expectedSource) {
  const inspected = inspectWebViewCandidates(children, expectedSource)
  if (inspected.matched.length === 1) return Object.freeze({ webview: inspected.matched[0], strategy: 'url', candidateCount: inspected.candidates.length })
  if (inspected.matched.length > 1) throw Object.assign(new Error(`WebView URL 匹配存在歧义，候选数量: ${inspected.candidates.length}`), { candidateCount: inspected.candidates.length, strategy: 'ambiguous-url' })
  if (inspected.candidates.length === 1) return Object.freeze({ webview: inspected.candidates[0], strategy: 'unique-fallback', candidateCount: 1 })
  throw Object.assign(new Error(`无法唯一绑定 WebView，候选数量: ${inspected.candidates.length}`), { candidateCount: inspected.candidates.length, strategy: inspected.candidates.length ? 'ambiguous' : 'none' })
}

export function waitForWebView(resolve, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 4000
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(10, options.delayMs) : 200
  const signal = options.signal
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now(); let timer = null; let attempt = 0; let settled = false; let lastError
    const finish = (callback, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); callback(value) }
    const cancelled = () => signal && (signal.aborted || signal.cancelled)
    const check = () => {
      if (cancelled()) return finish(reject, Object.assign(new Error('WebView 绑定已取消'), { code: 'WEBVIEW_BIND_CANCELLED' }))
      attempt += 1
      try { return finish(resolvePromise, resolve()) } catch (error) { lastError = error }
      const elapsed = Date.now() - startedAt
      if (elapsed >= timeoutMs) return finish(reject, Object.assign(lastError || new Error('WebView 绑定超时'), { code: 'WEBVIEW_BIND_TIMEOUT', attempts: attempt, elapsedMs: elapsed }))
      if (typeof options.onRetry === 'function') options.onRetry({ attempt, elapsedMs: elapsed, error: lastError })
      timer = setTimeout(check, Math.min(delayMs, timeoutMs - elapsed))
    }
    check()
  })
}

export function parseStartupReady(input, maxBytes) {
  const message = validateMessage(input, maxBytes)
  if (message.type !== 'ready' || message.sender !== 'h5' || message.generation !== 0) throw new Error('启动阶段仅接受合法 ready')
  return message
}
export function createStartupReadyBuffer(options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 4
  const items = []
  return {
    push(input) {
      let message
      try { message = parseStartupReady(input, options.maxBytes) } catch (error) { if (options.onDrop) options.onDrop({ reason: 'invalid', error }); return false }
      const duplicate = items.findIndex(item => item.sessionId === message.sessionId)
      if (duplicate >= 0) items.splice(duplicate, 1)
      if (items.length >= limit) { const dropped = items.shift(); if (options.onDrop) options.onDrop({ reason: 'overflow', message: dropped }) }
      items.push(message); if (options.onBuffered) options.onBuffered({ message, size: items.length }); return true
    },
    flush(receiver) { const pending = items.splice(0); pending.forEach((message, index) => { receiver(message); if (options.onFlushed) options.onFlushed({ message, index, remaining: pending.length - index - 1 }) }); return pending.length },
    clear(reason = 'clear') { const count = items.length; items.length = 0; if (count && options.onCleared) options.onCleared({ reason, count }); return count },
    size: () => items.length,
  }
}

export function attachRuntimeLifecycle({ pageWebview, globalEvent, show, hide, close }) {
  const subscriptions = []
  const on = (target, name, handler) => { if (!target || typeof target.addEventListener !== 'function') return; target.addEventListener(name, handler); subscriptions.push(() => { if (typeof target.removeEventListener === 'function') target.removeEventListener(name, handler) }) }
  on(pageWebview, 'show', show); on(pageWebview, 'hide', hide); on(pageWebview, 'close', close); on(globalEvent, 'resume', show); on(globalEvent, 'pause', hide)
  return () => subscriptions.splice(0).forEach(unsubscribe => unsubscribe())
}
export function createShellLifecycle(handlers = {}) {
  let visible = true; let destroyed = false; let destroyPromise = null
  return { show() { if (destroyed || visible) return false; visible = true; if (handlers.show) handlers.show(); return true }, hide(reason = 'page-hide') { if (destroyed || !visible) return false; visible = false; if (handlers.hide) handlers.hide(reason); return true }, destroy(reason = 'component-destroy') { if (destroyPromise) return destroyPromise; destroyed = true; destroyPromise = Promise.resolve(handlers.destroy ? handlers.destroy(reason) : undefined); return destroyPromise }, isVisible: () => visible && !destroyed, isDestroyed: () => destroyed }
}