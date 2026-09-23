import { BridgeCore } from './core/BridgeCore.js'
import { UniAppEvalJSTransport } from './transports/uniapp-evaljs.js'
import { registerBusinessActions } from './services/business-actions.js'
import { TransferManager } from './services/transfer-manager.js'
import { createDiagnosticLogger } from './diagnostics.js'

export const BUSINESS_CAPABILITIES = [
  'scan_start', 'scan_cancel',
  'bluetooth_getState', 'bluetooth_enable', 'bluetooth_disable', 'bluetooth_search',
  'scale_connect', 'scale_disconnect', 'scale_status', 'scale_readWeight',
  'printer_connect', 'printer_disconnect', 'printer_status', 'printer_print',
]

export function createAppBridge(options) {
  const log = createDiagnosticLogger({ enabled: options.debugLogging !== false, logger: options.logger })
  const transport = options.transport || new UniAppEvalJSTransport({ webview: options.webview, webviewId: options.webviewId, debugLogging: options.debugLogging, logger: options.logger })
  const capabilities = ['bridge.ping', 'bridge.info', ...BUSINESS_CAPABILITIES]
  let transfers
  let business
  const sessionCleanup = async info => {
    if (transfers) transfers.resetSession(info.sessionId)
    if (business) await business.resetSession(info.reason)
  }
  const core = new BridgeCore(Object.assign({}, options, { role: 'app', transport, capabilities, log, onSessionEnd: sessionCleanup }))
  core.register('bridge.ping', params => ({ pong: true, echo: params, timestamp: Date.now() }))
  core.register('bridge.info', () => ({ protocol: 'app-capability-bridge', version: 1, platform: 'android', capabilities }))
  transfers = new TransferManager(core, options.transferOptions)
  business = registerBusinessActions(core, { canvasId: options.canvasId, adapter: options.capabilityAdapter, transfers, log })
  let startPromise = null
  let destroyPromise = null
  return {
    core, transport,
    start() {
      if (startPromise) return startPromise
      if (destroyPromise) return Promise.reject(new BridgeError('BRIDGE_DESTROYED', 'Bridge unavailable'))
      const at = Date.now(); log('Shell', 'start.begin')
      startPromise = core.start().then(() => { if (destroyPromise) throw new BridgeError('BRIDGE_DESTROYED', 'Bridge unavailable'); log('Shell', 'start.success', { durationMs: Date.now() - at }) }, error => { log('Shell', 'start.failure', { code: error && error.code, durationMs: Date.now() - at }, 'error'); throw error })
      return startPromise
    },
    destroy(reason) {
      if (destroyPromise) return destroyPromise
      const at = Date.now(); log('Shell', 'destroy.begin', { reason })
      destroyPromise = Promise.resolve().then(async () => { try { await startPromise?.catch(() => undefined); await business.dispose() } finally { transfers.destroy(); await core.destroy(reason); log('Shell', 'destroy.success', { durationMs: Date.now() - at }) } })
      return destroyPromise
    },
    cancelScan: () => business.actions.scan_cancel(),
    register: (name, handler) => core.register(name, handler), unregister: name => core.unregister(name), subscribe: (event, handler) => core.subscribe(event, handler), unsubscribe: id => core.unsubscribe(id), emit: (event, payload) => core.emit(event, payload), call: (name, params, callOptions) => core.call(name, params, callOptions), waitUntilReady: opts => core.waitUntilReady(opts), getSnapshot: () => core.getSnapshot(), receive: message => transport.receive(message)
  }
}

export { attachRuntimeLifecycle, createShellLifecycle, createStartupReadyBuffer, getNativeWebViewId, getNativeWebViewUrl, getOwnedWebViewCandidates, getPageWebView, inspectWebViewCandidates, normalizeWebViewUrl, parseBridgeSource, parseStartupReady, resolveWebViewCandidate, waitForWebView } from './shell-runtime.js'
export { BridgeCore } from './core/BridgeCore.js'
export { createBusinessActions, registerBusinessActions } from './services/business-actions.js'
export { DIRECT_LIMIT_BYTES } from './services/action-validation.js'
export { BridgeError, PROTOCOL, VERSION } from './contract/protocol.js'
export { validateMessage } from './contract/validation.js'
export { UniAppEvalJSTransport, safeJson } from './transports/uniapp-evaljs.js'
export { MemoryTransport } from './transports/memory.js'
export { createDiagnosticLogger } from './diagnostics.js'
