<template>
  <view class="app-capability-bridge-shell">
    <web-view :id="webviewId" :src="resolvedSource.src" @load="handleWebViewLoaded" @message="handleWebViewMessage" @error="handleWebViewError"></web-view>
    <canvas :id="resolvedCanvasId" :canvas-id="resolvedCanvasId" class="bridge-hidden-canvas"></canvas>
  </view>
</template>

<script>
import { createAppBridge } from '../../js_sdk/index.js'
import { createDiagnosticLogger } from '../../js_sdk/diagnostics.js'
import { attachRuntimeLifecycle, createShellLifecycle, createStartupReadyBuffer, getNativeWebViewId, getNativeWebViewUrl, getOwnedWebViewCandidates, getPageWebView, parseBridgeSource, resolveWebViewCandidate, waitForWebView } from '../../js_sdk/shell-runtime.js'

let componentSequence = 0
export default {
  name: 'AppCapabilityBridgeShell',
  props: { src: { type: String, required: true }, canvasId: { type: String, default: '' }, bridgeOptions: { type: Object, default: () => ({}) } },
  data() {
    const sequence = ++componentSequence
    return { bridge: null, nativeWebview: null, startPromise: null, reloadPromise: null, lifecycle: null, detachRuntimeLifecycle: null, detachNativeLoaded: null, bindCancellation: null, bridgeGeneration: 0, startupReady: null, log: null, loadSourcesSeen: Object.create(null), lastLoadSignal: null, webviewId: `acb-webview-${sequence}`, resolvedCanvasId: this.canvasId || `acb-print-${sequence}` }
  },
  computed: { resolvedSource() { return parseBridgeSource(this.src) } },
  created() {
    this.log = createDiagnosticLogger({ enabled: this.bridgeOptions.debugLogging !== false, logger: this.bridgeOptions.logger })
    this.startupReady = createStartupReadyBuffer({
      limit: 4,
      onBuffered: ({ message, size }) => this.log('Shell', 'ready.buffered', { sessionId: message.sessionId, size }),
      onFlushed: ({ message, remaining }) => this.log('Shell', 'ready.flushed', { sessionId: message.sessionId, remaining }),
      onDrop: ({ reason, message }) => this.log('Shell', 'ready.dropped', { reason, sessionId: message && message.sessionId }, 'warn'),
      onCleared: ({ reason, count }) => this.log('Shell', 'ready.dropped', { reason, count }, 'warn')
    })
    this.lifecycle = createShellLifecycle({ hide: reason => { if (this.bridge) this.bridge.cancelScan(reason).catch(() => undefined) }, destroy: reason => this.destroyBridge(reason) })
  },
  mounted() {
    const pageWebview = this.getPageWebView()
    const globalEvent = typeof plus !== 'undefined' && plus.globalEvent
    this.detachRuntimeLifecycle = attachRuntimeLifecycle({ pageWebview, globalEvent, show: this.handleShow, hide: this.handleHide, close: () => this.destroy('webview-close') })
    this.log('Shell', 'mounted.start.schedule')
    this.$nextTick(() => {
      if (this.lifecycle.isDestroyed()) return
      this.log('Shell', 'mounted.start')
      this.start('mounted').catch(() => undefined)
    })
  },
  methods: {
    getPageWebView() {
      const getPages = typeof getCurrentPages === 'function' ? getCurrentPages : null
      const runtime = typeof plus !== 'undefined' ? plus : null
      return getPageWebView(this.$scope, getPages, runtime)
    },
    resolveWebView() {
      const page = this.getPageWebView()
      const runtime = typeof plus !== 'undefined' ? plus : null
      if (!page) throw Object.assign(new Error('当前 uni-app 页面原生 WebView 尚不可用'), { candidateCount: 0, strategy: 'page-unavailable' })
      return resolveWebViewCandidate(getOwnedWebViewCandidates(page, runtime), this.resolvedSource.src)
    },
    start(trigger = 'manual') {
      if (this.startPromise) { this.log('Shell', 'singleflight.reuse', { trigger, phase: 'start' }); return this.startPromise }
      if (this.reloadPromise && trigger !== 'reload') { this.log('Shell', 'singleflight.reuse', { trigger, phase: 'reload' }); return this.reloadPromise }
      if (this.bridge) return this.bridge.start()
      if (this.lifecycle.isDestroyed()) return Promise.resolve()
      const generation = ++this.bridgeGeneration
      const cancellation = { cancelled: false }; this.bindCancellation = cancellation
      const resolveOptions = Object.assign({ timeoutMs: 4000, delayMs: 200 }, this.bridgeOptions.webviewResolveOptions, {
        signal: cancellation,
        onRetry: info => { if (info.attempt === 1 || info.attempt % 5 === 0) this.log('Shell', 'bind.retry', { attempt: info.attempt, elapsedMs: info.elapsedMs, candidateCount: info.error && info.error.candidateCount, strategy: info.error && info.error.strategy }) }
      })
      this.log('Shell', 'bind.start', { generation, sourceKind: this.resolvedSource.kind })
      this.startPromise = waitForWebView(() => this.resolveWebView(), resolveOptions)
        .then(async resolved => {
          if (cancellation.cancelled || this.lifecycle.isDestroyed() || generation !== this.bridgeGeneration) return
          this.nativeWebview = resolved.webview
          this.attachNativeLoaded(resolved.webview)
          this.log('Shell', 'bind.result', { outcome: 'success', generation, candidateCount: resolved.candidateCount, strategy: resolved.strategy, webviewId: getNativeWebViewId(resolved.webview), webviewUrl: getNativeWebViewUrl(resolved.webview) })
          const bridge = createAppBridge(Object.assign({}, this.bridgeOptions, { webview: resolved.webview, webviewId: getNativeWebViewId(resolved.webview), canvasId: this.resolvedCanvasId }))
          this.bridge = bridge
          this.log('Shell', 'bridge.start', { generation })
          await bridge.start()
          if (this.bridge !== bridge || generation !== this.bridgeGeneration) return bridge.destroy('stale-generation')
          this.startupReady.flush(message => bridge.receive(message))
          this.log('Shell', 'bridge.success', { generation })
          bridge.waitUntilReady().then(() => { if (this.bridge === bridge) this.$emit('ready', bridge.getSnapshot()) }).catch(error => { if (this.bridge === bridge) this.$emit('error', error) })
        })
        .catch(error => { if (error && error.code === 'WEBVIEW_BIND_CANCELLED') return; this.log('Shell', 'bind.result', { outcome: 'failure', code: error && error.code, attempts: error && error.attempts, elapsedMs: error && error.elapsedMs, candidateCount: error && error.candidateCount, strategy: error && error.strategy }, 'error'); this.$emit('error', error); throw error })
        .finally(() => { if (this.bindCancellation === cancellation) this.bindCancellation = null; this.startPromise = null })
      return this.startPromise
    },
    reloadBridge(trigger = 'reload') {
      if (this.reloadPromise) { this.log('Shell', 'singleflight.reuse', { trigger, phase: 'reload' }); return this.reloadPromise }
      const pendingStart = this.startPromise
      this.reloadPromise = this.destroyBridge('webview-reload').then(() => pendingStart && pendingStart.catch(() => undefined)).then(() => { if (!this.lifecycle.isDestroyed()) return this.start('reload') }).finally(() => { this.reloadPromise = null })
      return this.reloadPromise
    },
    attachNativeLoaded(webview) {
      if (this.detachNativeLoaded) this.detachNativeLoaded()
      if (!webview || typeof webview.addEventListener !== 'function') return
      const handler = () => this.handleLoadSignal('native')
      webview.addEventListener('loaded', handler)
      let detached = false
      this.detachNativeLoaded = () => { if (detached) return; detached = true; if (typeof webview.removeEventListener === 'function') webview.removeEventListener('loaded', handler) }
    },
    handleLoadSignal(source) {
      const now = Date.now()
      if (this.lastLoadSignal && now - this.lastLoadSignal.at < 100 && this.lastLoadSignal.source !== source) {
        this.log('Shell', 'load.supplemental', { source, reason: 'duplicate-runtime-signal' })
        return this.start('load-supplemental').catch(() => undefined)
      }
      this.lastLoadSignal = { source, at: now }
      const firstForSource = !this.loadSourcesSeen[source]
      this.loadSourcesSeen[source] = true
      if (firstForSource) {
        this.log('Shell', 'load.supplemental', { source, reason: this.bridge ? 'late-first-load' : 'initial-load' })
        return this.start('load-supplemental').catch(() => undefined)
      }
      this.log('Shell', 'load.reload', { source })
      return this.reloadBridge('load-reload').catch(() => undefined)
    },
    async destroyBridge(reason) {
      this.bridgeGeneration += 1
      if (this.bindCancellation) this.bindCancellation.cancelled = true
      if (this.detachNativeLoaded) { this.detachNativeLoaded(); this.detachNativeLoaded = null }
      this.startupReady.clear(reason)
      const bridge = this.bridge; this.bridge = null; this.nativeWebview = null
      if (bridge) { await bridge.destroy(reason); this.$emit('state-change', bridge.getSnapshot()) }
    },
    destroy(reason = 'component-destroy') { return this.lifecycle.destroy(reason) },
    call(method, params, options) { return this.bridge ? this.bridge.call(method, params, options) : Promise.reject(new Error('Bridge 尚未启动')) },
    register(method, handler) { if (!this.bridge) throw new Error('Bridge 尚未启动'); return this.bridge.register(method, handler) },
    getSnapshot() { return this.bridge ? this.bridge.getSnapshot() : Object.freeze({ state: 'idle', ready: false }) },
    handleShow() { this.lifecycle.show() },
    handleHide() { this.lifecycle.hide('app-hide') },
    handleWebViewLoaded() { this.handleLoadSignal('template') },
    handleWebViewMessage(event) {
      if (!this.lifecycle.isVisible()) { this.log('Shell', 'receive.dropped', { reason: 'hidden' }, 'warn'); return }
      const data = event && event.detail && event.detail.data
      ;(Array.isArray(data) ? data : [data]).filter(Boolean).forEach(message => { if (this.bridge) this.bridge.receive(message); else this.startupReady.push(message) })
    },
    handleWebViewError(event) { this.log('Shell', 'webview.error', {}, 'error'); this.$emit('error', event) }
  },
  beforeDestroy() { if (this.detachRuntimeLifecycle) this.detachRuntimeLifecycle(); this.destroy('component-destroy') }
}
</script>

<style scoped>
.app-capability-bridge-shell { width: 100%; height: 100%; }
.bridge-hidden-canvas { position: fixed; left: -10000px; top: -10000px; width: 960px; height: 960px; opacity: 0; pointer-events: none; }
</style>