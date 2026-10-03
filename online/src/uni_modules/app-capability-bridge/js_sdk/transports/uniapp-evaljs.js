import { BridgeError, RECEIVER_NAME } from '../contract/protocol.js'

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export class UniAppEvalJSTransport {
  constructor(options = {}) { this.webview = options.webview; this.expectedId = options.webviewId || ''; this.receiver = null; this.destroyed = false }
  bind(webview) {
    if (!webview || typeof webview.evalJS !== 'function') throw new BridgeError('WEBVIEW_BIND_FAILED', 'Invalid WebView instance')
    const id = typeof webview.id === 'string' ? webview.id : (typeof webview.getStyle === 'function' && webview.getStyle() && webview.getStyle().id) || ''
    this.webview = webview; if (id) this.expectedId = id
  }
  start(receiver) { if (!this.webview || typeof this.webview.evalJS !== 'function') throw new BridgeError('WEBVIEW_BIND_FAILED', 'WebView is not explicitly bound'); this.receiver = receiver; this.destroyed = false }
  receive(message) { if (!this.destroyed && this.receiver) this.receiver(message) }
  send(message) {
    if (this.destroyed || !this.webview || typeof this.webview.evalJS !== 'function') throw new BridgeError('BRIDGE_DESTROYED', 'WebView transport unavailable')
    try { this.webview.evalJS(`window.${RECEIVER_NAME}&&window.${RECEIVER_NAME}(${safeJson(message)});`) }
    catch (error) { throw new BridgeError('SEND_FAILED', 'WebView evalJS failed') }
  }
  destroy() { this.destroyed = true; this.receiver = null; this.webview = null }
}

export { safeJson }