import { BridgeCore } from '../js_sdk/core/BridgeCore.js'
import { MemoryTransport } from '../js_sdk/transports/memory.js'
import { safeJson } from '../js_sdk/transports/uniapp-evaljs.js'
import { validateMessage } from '../js_sdk/contract/validation.js'

async function pair() {
  const h = new MemoryTransport(); const a = new MemoryTransport(); h.connect(a)
  const sessionId = 'test-session'
  const h5 = new BridgeCore({ role: 'h5', transport: h, sessionId, readyRetryMs: 10, connectTimeoutMs: 1000, limits: { maxInbound: 128 } })
  const app = new BridgeCore({ role: 'app', transport: a, connectTimeoutMs: 1000, limits: { maxInbound: 128 } })
  await app.start(); await h5.start(); await Promise.all([h5.waitUntilReady({ timeoutMs: 500 }), app.waitUntilReady({ timeoutMs: 500 })])
  return { h5, app, h, a }
}

describe('app-capability-bridge Core', () => {
  test('explicit start has no constructor side effects and supports two-way RPC', async () => {
    const { h5, app } = await pair()
    app.register('bridge.ping', value => value); h5.register('h5.echo', value => value)
    await expect(h5.call('bridge.ping', { side: 'h5' })).resolves.toEqual({ side: 'h5' })
    await expect(app.call('h5.echo', { side: 'app' })).resolves.toEqual({ side: 'app' })
    await Promise.all([h5.destroy(), app.destroy()])
  })
  test('validates registered business actions inside their outer adapter and preserves the legacy envelope', async () => {
    const { h5, app } = await pair()
    const action = jest.fn(async params => params === undefined
      ? { status: 'success', code: 'OK', message: '', data: { enabled: true } }
      : { status: 'error', code: 'INVALID_ARGUMENT', message: '不接受参数', data: {} })
    app.register('bluetooth_getState', action)
    await expect(h5.call('bluetooth_getState')).resolves.toEqual({ status: 'success', code: 'OK', message: '', data: { enabled: true } })
    await expect(h5.call('bluetooth_getState', {})).resolves.toEqual({ status: 'error', code: 'INVALID_ARGUMENT', message: '不接受参数', data: {} })
    expect(action).toHaveBeenCalledTimes(2)
    await Promise.all([h5.destroy(), app.destroy()])
  })
  test('unregistered printer_preview uses the ordinary method-not-found response', async () => {
    const { h5, app } = await pair()
    await expect(h5.call('printer_preview', { image: 'https://example.com/a.png', width: 80, height: 40 })).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
    await Promise.all([h5.destroy(), app.destroy()])
  })
  test('supports isolated multi-subscription events and unsubscribe', async () => {
    const { h5, app } = await pair(); const first = jest.fn(); const second = jest.fn()
    const a = await h5.subscribe('scan.data', first); const b = await h5.subscribe('scan.data', second)
    await app.emit('scan.data', { value: 'A' }); await app.emit('scan.data', { value: 'B' })
    expect(first.mock.calls.map(call => call[1].eventSeq)).toEqual([1, 2]); expect(second).toHaveBeenCalledTimes(2)
    await h5.unsubscribe(a); await app.emit('scan.data', { value: 'C' })
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(3)
    await Promise.all([h5.destroy(), app.destroy()]); expect(await app.emit('scan.data', null)).toBe(0)
  })
  test('matches 100 concurrent out-of-order responses', async () => {
    const { h5, app, a } = await pair(); a.delay = 10
    app.register('echo', async value => { await new Promise(resolve => setTimeout(resolve, Math.random() * 10)); return value })
    const values = Array.from({ length: 100 }, (_, index) => index)
    await expect(Promise.all(values.map(value => h5.call('echo', value)))).resolves.toEqual(values)
    expect(h5.getSnapshot().pending).toBe(0); await Promise.all([h5.destroy(), app.destroy()])
  })
  test('accepts a new H5 session after reload and advances generation', async () => {
    const sent = []
    const app = new BridgeCore({ role: 'app', transport: { start() {}, send(message) { sent.push(message) }, destroy() {} }, connectTimeoutMs: 1000 })
    await app.start()
    const ready = sessionId => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId, generation: 0, messageId: `m-${sessionId}`, sentAt: Date.now(), capabilitiesRequested: [] })
    await app.receive(ready('first-session'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'first-session', generation: 1 })
    await app.receive(ready('second-session'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'second-session', generation: 2 })
    expect(sent.filter(message => message.type === 'ready-ack')).toHaveLength(2)
    await app.receive(ready('first-session'))
    expect(app.getSnapshot()).toMatchObject({ sessionId: 'second-session', generation: 2 })
    expect(sent.filter(message => message.type === 'ready-ack')).toHaveLength(2)
    await app.destroy()
  })
  test('retries ready ack after first send rejection and accepts a second session', async () => {
    const logs = []; const sent = []; let rejectFirst = true
    const transport = { start() {}, send(message) { sent.push(message); if (message.type === 'ready-ack' && rejectFirst) { rejectFirst = false; return Promise.reject(Object.assign(new Error('send failed'), { code: 'SEND_FAILED' })) } }, destroy() {} }
    const app = new BridgeCore({ role: 'app', transport, log: (module, event, detail) => logs.push({ module, event, detail }) })
    const ready = sessionId => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId, generation: 0, messageId: `m-${sessionId}-${sent.length}`, sentAt: Date.now(), capabilitiesRequested: [] })
    await app.start(); await app.receive(ready('first'))
    expect(app.getSnapshot().state).toBe('listening'); expect(logs.map(item => item.event)).toContain('ack.send.failure')
    await app.receive(ready('first'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'first', generation: 1 })
    await app.receive(ready('second'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'second', generation: 2 })
    await app.destroy()
  })
  test('keeps App listening before first H5 and reconnects after disconnect', async () => {
    jest.useFakeTimers()
    const sent = []; const ended = jest.fn()
    const app = new BridgeCore({ role: 'app', transport: { start() {}, send(message) { sent.push(message) }, destroy() {} }, connectTimeoutMs: 5, onSessionEnd: ended })
    await app.start(); jest.advanceTimersByTime(100)
    expect(app.getSnapshot().state).toBe('listening')
    await expect(app.call('h5.echo')).rejects.toMatchObject({ code: 'BRIDGE_NOT_CONNECTED' })
    const ready = sessionId => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId, generation: 0, messageId: `m-${sessionId}`, sentAt: Date.now(), capabilitiesRequested: [] })
    await app.receive(ready('late'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'late', generation: 1 })
    await app.receive({ protocol: 'app-capability-bridge', version: 1, type: 'disconnect', sender: 'h5', sessionId: 'late', generation: 1, messageId: 'disconnect-late', sentAt: Date.now(), reason: 'pagehide' })
    expect(app.getSnapshot()).toMatchObject({ state: 'listening', ready: false })
    await app.receive(ready('next'))
    expect(app.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'next', generation: 2 })
    expect(ended).toHaveBeenCalledTimes(2)
    await app.destroy(); jest.useRealTimers()
  })
  test('drops late async handler completion from a replaced session', async () => {
    const sent = []; let release
    const app = new BridgeCore({ role: 'app', transport: { start() {}, send(message) { sent.push(message) }, destroy() {} } })
    const ready = id => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId: id, generation: 0, messageId: `ready-${id}`, sentAt: 1, capabilitiesRequested: [] })
    await app.start(); await app.receive(ready('one'))
    app.register('slow', () => new Promise(resolve => { release = resolve }))
    app.receive({ protocol: 'app-capability-bridge', version: 1, type: 'request', sender: 'h5', sessionId: 'one', generation: 1, messageId: 'request-one', sentAt: 2, requestId: 'r1', method: 'slow', params: null })
    await Promise.resolve(); const replacement = app.receive(ready('two')); await Promise.resolve(); release('late'); await replacement; await Promise.resolve()
    expect(sent.filter(message => message.type === 'response' && message.requestId === 'r1')).toHaveLength(0)
    await app.destroy()
  })
  test('logs invalid inbound messages without weakening validation', async () => {
    const logs = []; const app = new BridgeCore({ role: 'app', transport: { start() {}, send() {}, destroy() {} }, log: (module, event, detail) => logs.push({ module, event, detail }) })
    await app.start(); app.receive({ protocol: 'wrong' })
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'receive.dropped', detail: expect.objectContaining({ reason: 'invalid' }) })]))
    await app.destroy()
  })
  test('logs action lifecycle with redacted identifiers and no params or result', async () => {
    const logs = []; const { h5, app } = await pair(); app.log = (module, event, detail, level) => logs.push({ module, event, detail, level })
    app.register('logged_action', async () => ({ code: 'OK', secret: 'must-not-log' }))
    await h5.call('logged_action', { token: 'must-not-log' })
    expect(logs.map(item => `${item.module}.${item.event}`)).toEqual(expect.arrayContaining(['Action.receive', 'Action.invoke', 'Action.result']))
    const text = JSON.stringify(logs)
    expect(text).not.toContain('must-not-log'); expect(text).toContain('logged_action'); expect(text).toContain('durationMs')
    await Promise.all([h5.destroy(), app.destroy()])
  })
  test('logs business-error envelopes as handled results instead of thrown action errors', async () => {
    const logs = []; const { h5, app } = await pair(); app.log = (module, event, detail, level) => logs.push({ module, event, detail, level })
    app.register('bluetooth_disable', async () => ({ status: 'error', code: 'SYSTEM_BLUETOOTH_DISABLE_DENIED', message: '用户未允许关闭系统蓝牙', data: { enabled: true, pending: false } }))
    await expect(h5.call('bluetooth_disable')).resolves.toMatchObject({ status: 'error', code: 'SYSTEM_BLUETOOTH_DISABLE_DENIED' })
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'Action', event: 'result', level: 'warn', detail: expect.objectContaining({ code: 'SYSTEM_BLUETOOTH_DISABLE_DENIED' }) })]))
    expect(logs).not.toEqual(expect.arrayContaining([expect.objectContaining({ module: 'Action', event: 'error' })]))
    await Promise.all([h5.destroy(), app.destroy()])
  })
  test('removes timeout queue entries and destroy clears resources', async () => {
    jest.useRealTimers()
    const core = new BridgeCore({ role: 'h5', transport: new MemoryTransport(), limits: { maxQueue: 1 } })
    await expect(core.call('slow', null, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(core.getSnapshot().queued).toBe(0); await core.destroy()
    expect(core.getSnapshot()).toMatchObject({ state: 'destroyed', pending: 0, queued: 0, inbound: 0 })
  })
})

describe('protocol validation and evalJS serialization', () => {
  const base = { protocol: 'app-capability-bridge', version: 1, type: 'request', sender: 'h5', sessionId: 's', generation: 1, messageId: 'm', sentAt: 1, requestId: 'r', method: 'echo', params: null }
  test('rejects unknown fields and getters without invoking getter', () => {
    expect(() => validateMessage({ ...base, unknown: true })).toThrow()
    const getter = jest.fn(); const value = { ...base }; Object.defineProperty(value, 'params', { enumerable: true, get: getter })
    expect(() => validateMessage(value)).toThrow(); expect(getter).not.toHaveBeenCalled()
  })
  test('escapes script-sensitive content', () => {
    const result = safeJson({ value: '</script>\u2028\u2029' })
    expect(result).not.toContain('</script>'); expect(result).toContain('\\u003c/script>'); expect(result).toContain('\\u2028')
  })
})