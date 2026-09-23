import { BridgeError, DEFAULT_LIMITS, METHOD_PATTERN, PROTOCOL, VERSION, safeError } from '../contract/protocol.js'
import { validateMessage } from '../contract/validation.js'

let sequence = 0
const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`

export class BridgeCore {
  constructor(options) {
    if (!options || !['h5', 'app'].includes(options.role) || !options.transport) throw new BridgeError('INITIALIZATION_FAILED', 'Invalid bridge options')
    this.options = options; this.state = 'idle'; this.generation = 0; this.sessionId = options.sessionId || makeId(options.role)
    this.limits = Object.assign({}, DEFAULT_LIMITS, options.limits); this.handlers = new Map(); this.pending = new Map()
    this.queueOrder = []; this.queueEntries = new Map(); this.inbound = new Set(); this.startPromise = null; this.destroyPromise = null
    this.seenSessions = new Set()
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.readyTimer = null; this.connectTimer = null; this.eventHandlers = new Map(); this.remoteSubscriptions = new Map(); this.eventSequence = new Map()
    this.register('bridge.event.subscribe', params => { if (!params || typeof params.subscriptionId !== 'string' || typeof params.event !== 'string') throw new BridgeError('INVALID_ARGUMENT', 'Invalid subscription'); this.remoteSubscriptions.set(params.subscriptionId, params.event); this.eventSequence.set(params.subscriptionId, 0); return { subscriptionId: params.subscriptionId } })
    this.register('bridge.event.unsubscribe', params => { const id = params && params.subscriptionId; this.remoteSubscriptions.delete(id); this.eventSequence.delete(id); return { unsubscribed: true } })
    this.register('bridge.event.deliver', params => { const entry = params && this.eventHandlers.get(params.subscriptionId); if (entry && entry.event === params.event && Number.isInteger(params.eventSeq) && params.eventSeq > entry.lastSeq) { entry.lastSeq = params.eventSeq; entry.handler(params.payload, Object.freeze({ subscriptionId: params.subscriptionId, event: params.event, eventSeq: params.eventSeq, sessionId: this.sessionId })) } return { delivered: !!entry } })
  }
  start() {
    if (this.startPromise) return this.startPromise
    if (this.state !== 'idle') return Promise.reject(new BridgeError('BRIDGE_FAILED', 'Bridge cannot be started'))
    this.state = 'starting'
    this.startPromise = Promise.resolve().then(() => this.options.transport.start && this.options.transport.start(message => this.receive(message))).then(async () => {
      this.state = 'connecting'
      if (this.options.role === 'h5') { await this.sendReady(); this.readyTimer = setInterval(() => this.sendReady().catch(() => {}), this.options.readyRetryMs || 500) }
      this.connectTimer = setTimeout(() => this.fail('CONNECT_TIMEOUT', 'Bridge connection timed out'), this.options.connectTimeoutMs || 15000)
    }).catch(error => { this.fail('INITIALIZATION_FAILED', 'Bridge initialization failed'); throw error instanceof BridgeError ? error : new BridgeError('INITIALIZATION_FAILED', 'Bridge initialization failed') })
    return this.startPromise
  }
  register(method, handler) {
    if (!METHOD_PATTERN.test(method) || typeof handler !== 'function' || this.handlers.has(method)) throw new BridgeError('INVALID_MESSAGE', 'Invalid or duplicate method registration')
    this.handlers.set(method, handler); let active = true
    return () => { if (active && this.handlers.get(method) === handler) this.handlers.delete(method); active = false }
  }
  unregister(method) { this.handlers.delete(method) }
  async subscribe(event, handler) {
    if (!METHOD_PATTERN.test(event) || typeof handler !== 'function') throw new BridgeError('INVALID_ARGUMENT', 'Invalid event subscription')
    const subscriptionId = makeId('subscription'); this.eventHandlers.set(subscriptionId, { event, handler, lastSeq: 0 })
    try { await this.call('bridge.event.subscribe', { subscriptionId, event }); return subscriptionId } catch (error) { this.eventHandlers.delete(subscriptionId); throw error }
  }
  async unsubscribe(subscriptionId) { const existed = this.eventHandlers.delete(subscriptionId); if (existed && this.state === 'ready') await this.call('bridge.event.unsubscribe', { subscriptionId }).catch(() => {}); return existed }
  async emit(event, payload = null) {
    if (!METHOD_PATTERN.test(event)) throw new BridgeError('INVALID_ARGUMENT', 'Invalid event')
    const tasks = []
    for (const [subscriptionId, subscribedEvent] of this.remoteSubscriptions) if (subscribedEvent === event) { const eventSeq = (this.eventSequence.get(subscriptionId) || 0) + 1; this.eventSequence.set(subscriptionId, eventSeq); tasks.push(this.call('bridge.event.deliver', { subscriptionId, event, eventSeq, payload })) }
    await Promise.all(tasks); return tasks.length
  }
  call(method, params, options = {}) {
    if (!['idle', 'starting', 'connecting', 'ready'].includes(this.state)) return Promise.reject(new BridgeError('BRIDGE_DESTROYED', 'Bridge unavailable'))
    if (!METHOD_PATTERN.test(method)) return Promise.reject(new BridgeError('INVALID_MESSAGE', 'Invalid method'))
    if (this.pending.size >= this.limits.maxPending) return Promise.reject(new BridgeError('TOO_MANY_PENDING', 'Pending limit reached'))
    const requestId = makeId('request'); const message = this.message('request', Object.assign({ requestId, method }, params === undefined ? {} : { params }, options.operationId ? { operationId: options.operationId } : {}))
    const startedAt = Date.now()
    this.log('RPC', 'send', { action: method, requestId, operationId: options.operationId })
    const promise = new Promise((resolve, reject) => { const timer = setTimeout(() => this.finish(requestId, new BridgeError('TIMEOUT', `Call timed out: ${method}`)), options.timeoutMs || this.options.defaultTimeoutMs || 15000); this.pending.set(requestId, { resolve, reject, timer, method, operationId: options.operationId, startedAt }) })
    if (this.state === 'ready') this.submit(message)
    else if (this.queueEntries.size >= this.limits.maxQueue) this.finish(requestId, new BridgeError('QUEUE_OVERFLOW', 'Queue limit reached'))
    else { this.queueOrder.push(requestId); this.queueEntries.set(requestId, message) }
    return promise
  }
  waitUntilReady(options = {}) {
    if (this.state === 'ready') return Promise.resolve()
    return new Promise((resolve, reject) => { const check = setInterval(() => { if (this.state === 'ready') done(resolve); else if (['failed', 'destroying', 'destroyed'].includes(this.state)) done(() => reject(new BridgeError('BRIDGE_FAILED', 'Bridge unavailable'))) }, 10); const timeout = setTimeout(() => done(() => reject(new BridgeError('CONNECT_TIMEOUT', 'Bridge connection timed out'))), options.timeoutMs || 15000); const done = callback => { clearInterval(check); clearTimeout(timeout); callback() } })
  }
  isReady() { return this.state === 'ready' }
  getSnapshot() { return Object.freeze({ state: this.state, ready: this.isReady(), sessionId: this.sessionId, generation: this.generation, pending: this.pending.size, queued: this.queueEntries.size, inbound: this.inbound.size }) }
  receive(input) {
    let message; try { message = validateMessage(input, this.limits.maxMessageUtf8Bytes) } catch (error) { this.log('Core', 'receive.dropped', { reason: 'invalid', code: error && error.code }, 'warn'); return }
    if (message.sender === this.options.role) { this.log('Core', 'receive.dropped', { reason: 'same-sender', type: message.type }, 'warn'); return }
    if (message.type === 'ready' && this.options.role === 'app' && ['connecting', 'ready'].includes(this.state)) {
      const newSession = this.state === 'ready' && message.sessionId !== this.sessionId
      if (newSession && this.seenSessions.has(message.sessionId)) return
      if (newSession) {
        if (this.sessionId) this.seenSessions.add(this.sessionId)
        if (this.seenSessions.size > 64) this.seenSessions.delete(this.seenSessions.values().next().value)
        ;[...this.pending.keys()].forEach(id => this.finish(id, new BridgeError('SESSION_REPLACED', 'H5 session was replaced')))
        this.queueOrder.length = 0; this.queueEntries.clear(); this.inbound.clear(); this.eventHandlers.clear(); this.remoteSubscriptions.clear(); this.eventSequence.clear()
        this.generation += 1
      } else if (!this.generation) this.generation = this.options.generation || 1
      this.sessionId = message.sessionId
      this.log('Core', 'ack.send.start', { sessionId: message.sessionId, generation: this.generation })
      Promise.resolve(this.options.transport.send(this.message('ready-ack', { accepted: true, capabilities: this.options.capabilities || [], limits: this.limits }, this.generation)))
        .then(() => { this.log('Core', 'ack.send.success', { sessionId: message.sessionId, generation: this.generation }); this.ready() })
        .catch(error => { this.log('Core', 'ack.send.failure', { sessionId: message.sessionId, generation: this.generation, code: error && error.code }, 'error') })
      return
    }
    if (message.sessionId !== this.sessionId) { this.log('Core', 'receive.dropped', { reason: 'session-mismatch', type: message.type }, 'warn'); return }
    if (message.type === 'ready-ack' && this.options.role === 'h5' && this.state === 'connecting') { if (!message.accepted) return this.fail('SESSION_ACK_TIMEOUT', 'Bridge session rejected'); this.generation = message.generation; this.ready(); return }
    if (this.state !== 'ready' || message.generation !== this.generation) { this.log('Core', 'receive.dropped', { reason: this.state !== 'ready' ? 'not-ready' : 'generation-mismatch', type: message.type }, 'warn'); return }
    if (message.type === 'response') this.response(message); else if (message.type === 'request') this.request(message)
  }
  destroy(reason = 'Bridge destroyed') {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyPromise = Promise.resolve().then(async () => { if (this.state === 'destroyed') return; this.state = 'destroying'; this.clearTimers(); [...this.pending.keys()].forEach(id => this.finish(id, new BridgeError('BRIDGE_DESTROYED', reason))); this.queueOrder.length = 0; this.queueEntries.clear(); this.inbound.clear(); this.eventHandlers.clear(); this.remoteSubscriptions.clear(); this.eventSequence.clear(); this.handlers.clear(); try { await this.options.transport.destroy() } finally { this.state = 'destroyed' } })
    return this.destroyPromise
  }
  message(type, extra, generation = this.generation) { return Object.assign({ protocol: PROTOCOL, version: VERSION, type, sender: this.options.role, sessionId: this.sessionId, generation, messageId: makeId('message'), sentAt: Date.now() }, extra) }
  sendReady() { return Promise.resolve(this.options.transport.send(this.message('ready', { capabilitiesRequested: this.options.capabilitiesRequested || [] }, 0))) }
  ready() { this.state = 'ready'; this.clearTimers(); this.flush() }
  clearTimers() { clearInterval(this.readyTimer); clearTimeout(this.connectTimer); this.readyTimer = this.connectTimer = null }
  fail(code, message) { if (['destroying', 'destroyed'].includes(this.state)) return; this.state = 'failed'; this.clearTimers(); [...this.pending.keys()].forEach(id => this.finish(id, new BridgeError(code, message))) }
  finish(id, error, result) {
    const pending = this.pending.get(id); if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(id); this.queueEntries.delete(id)
    this.log('RPC', 'response', { action: pending.method, requestId: id, operationId: pending.operationId, durationMs: Date.now() - pending.startedAt, code: error ? error.code : 'OK' }, error ? 'error' : 'info')
    error ? pending.reject(error) : pending.resolve(result === undefined ? null : result)
  }
  submit(message) { Promise.resolve(this.options.transport.send(message)).catch(() => this.finish(message.requestId, new BridgeError('SEND_FAILED', 'Message submission failed'))) }
  async flush() {
    const queued = this.queueOrder.splice(0)
    this.log('Core', 'buffer.flush.start', { count: queued.length })
    for (const id of queued) { const message = this.queueEntries.get(id); this.queueEntries.delete(id); if (message && this.pending.has(id) && this.state === 'ready') await this.submit(message) }
    this.log('Core', 'buffer.flush.success', { count: queued.length })
  }
  response(message) { if (message.ok) this.finish(message.requestId, null, message.result); else this.finish(message.requestId, new BridgeError(message.error.code || 'HANDLER_ERROR', message.error.message || 'Remote error', message.error.data)) }
  async request(message) {
    if (this.inbound.has(message.requestId)) return
    const handler = this.handlers.get(message.method)
    if (!handler) return this.options.transport.send(this.message('response', { requestId: message.requestId, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Method not found' } }))
    if (this.inbound.size >= this.limits.maxInbound) return this.options.transport.send(this.message('response', { requestId: message.requestId, ok: false, error: { code: 'BUSY', message: 'Handler limit reached' } }))
    this.inbound.add(message.requestId); const generation = this.generation; const startedAt = Date.now()
    const detail = { action: message.method, requestId: message.requestId, operationId: message.operationId }
    this.log('Action', 'receive', detail)
    try {
      this.log('Action', 'invoke', detail)
      const result = await handler(message.params, Object.freeze({ requestId: message.requestId, operationId: message.operationId, sessionId: this.sessionId, generation }))
      const resultCode = result && typeof result.code === 'string' ? result.code : 'OK'
      const resultMessage = result && typeof result.message === 'string' ? result.message : ''
      const businessFailure = result && (result.status === 'error' || result.status === 'unsupported')
      this.log('Action', businessFailure ? 'result' : (resultCode === 'OK' ? 'result' : 'error'), Object.assign({}, detail, { durationMs: Date.now() - startedAt, code: resultCode, errorMessage: resultCode === 'OK' ? undefined : resultMessage }), businessFailure ? 'warn' : (resultCode === 'OK' ? 'info' : 'error'))
      if (this.state === 'ready' && generation === this.generation) await this.options.transport.send(this.message('response', { requestId: message.requestId, ok: true, result: result === undefined ? null : result }))
    }
    catch (error) {
      const safe = safeError(error)
      this.log('Action', 'error', Object.assign({}, detail, { durationMs: Date.now() - startedAt, code: safe.code }), 'error')
      if (this.state === 'ready' && generation === this.generation) await this.options.transport.send(this.message('response', { requestId: message.requestId, ok: false, error: safe }))
    }
    finally { this.inbound.delete(message.requestId) }
  }
}