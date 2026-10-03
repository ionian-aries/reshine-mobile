import { describe, expect, it, vi } from 'vitest';
import { BridgeCore } from '../../src/bridge/BridgeCore';
import type { BridgeMessage, BridgeTransport } from '../../src/bridge/contract';
import { validateMessage } from '../../src/bridge/validation';

class PairTransport implements BridgeTransport {
  receiver?: (message: unknown) => void;
  peer?: PairTransport;
  delay = 0;
  start(receiver: (message: unknown) => void) { this.receiver = receiver; }
  async send(message: BridgeMessage) { await new Promise((resolve) => setTimeout(resolve, this.delay ? Math.random() * this.delay : 0)); this.peer?.receiver?.(message); }
  destroy() { this.receiver = undefined; }
}
function pair() { const h = new PairTransport(); const a = new PairTransport(); h.peer = a; a.peer = h; return [h, a] as const; }

async function cores() {
  const [ht, at] = pair(); const sessionId = 'session-test';
  const h5 = new BridgeCore({ role: 'h5', transport: ht, sessionId, readyRetryMs: 10, connectTimeoutMs: 1000 });
  const app = new BridgeCore({ role: 'app', transport: at, sessionId, connectTimeoutMs: 1000, limits: { maxInbound: 128 } });
  await app.start(); await h5.start(); await Promise.all([h5.waitUntilReady({ timeoutMs: 500 }), app.waitUntilReady({ timeoutMs: 500 })]);
  return { h5, app, ht, at };
}

describe('BridgeCore', () => {
  it('has no constructor side effects and supports explicit start', async () => {
    const transport = { start: vi.fn(), send: vi.fn(), destroy: vi.fn() };
    const core = new BridgeCore({ role: 'h5', transport });
    expect(transport.start).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
    await core.start(); expect(transport.start).toHaveBeenCalledOnce(); expect(transport.send).toHaveBeenCalled(); await core.destroy();
  });
  it('supports multiple event subscriptions, ordering and unsubscribe', async () => {
    const { h5, app } = await cores(); const first = vi.fn(); const second = vi.fn();
    const a = await h5.subscribe('scan.data', first); await h5.subscribe('scan.data', second);
    await app.emit('scan.data', { value: 'A' }); await app.emit('scan.data', { value: 'B' });
    expect(first.mock.calls.map((call) => call[1].eventSeq)).toEqual([1, 2]); expect(second).toHaveBeenCalledTimes(2);
    await h5.unsubscribe(a); await app.emit('scan.data', null); expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(3);
    await Promise.all([h5.destroy(), app.destroy()]); expect(await app.emit('scan.data')).toBe(0);
  });
  it('matches concurrent out-of-order responses', async () => {
    const { h5, app, at } = await cores(); at.delay = 10;
    app.register('echo', async (value) => { await new Promise((r) => setTimeout(r, Math.random() * 15)); return value; });
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(await Promise.all(values.map((value) => h5.call('echo', value)))).toEqual(values);
    expect(h5.getSnapshot().pending).toBe(0); await Promise.all([h5.destroy(), app.destroy()]);
  });
  it('reconnects when App receives a new H5 session', async () => {
    const sent: BridgeMessage[] = [];
    const app = new BridgeCore({ role: 'app', transport: { start() {}, send(message) { sent.push(message); }, destroy() {} }, connectTimeoutMs: 1000 });
    await app.start();
    const ready = (sessionId: string) => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId, generation: 0, messageId: `m-${sessionId}`, sentAt: Date.now(), capabilitiesRequested: [] } as BridgeMessage);
    app.receive(ready('first')); expect(app.getSnapshot()).toMatchObject({ sessionId: 'first', generation: 1, state: 'ready' });
    app.receive(ready('second')); expect(app.getSnapshot()).toMatchObject({ sessionId: 'second', generation: 2, state: 'ready' });
    expect(sent.filter((message) => message.type === 'ready-ack')).toHaveLength(2); await app.destroy();
  });
  it('removes timed out queued entries immediately', async () => {
    const transport = { send: vi.fn(), destroy: vi.fn() };
    const core = new BridgeCore({ role: 'h5', transport, limits: { maxQueue: 1 } });
    await expect(core.call('slow', null, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(core.getSnapshot().queued).toBe(0); const second = core.call('slow', null, { timeoutMs: 5 });
    await expect(second).rejects.toMatchObject({ code: 'TIMEOUT' }); await core.destroy();
  });
  it('omits params from a no-argument request snapshot', async () => {
    const sent: BridgeMessage[] = [];
    const core = new BridgeCore({ role: 'h5', transport: { send(message) { sent.push(message); }, destroy() {} } });
    const pending = core.call('bluetooth_enable', undefined, { timeoutMs: 50 });
    const request = (core as any).queueEntries.values().next().value;
    expect(request.method).toBe('bluetooth_enable'); expect(Object.prototype.hasOwnProperty.call(request, 'params')).toBe(false);
    expect(() => validateMessage(JSON.stringify(request))).not.toThrow();
    await core.destroy(); await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_DESTROYED' });
  });
  it('rejects pending once and clears resources on destroy', async () => {
    const core = new BridgeCore({ role: 'h5', transport: { send() {}, destroy() {} } });
    const pending = core.call('wait'); await core.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_DESTROYED' });
    expect(core.getSnapshot()).toMatchObject({ state: 'destroyed', pending: 0, queued: 0, inbound: 0 });
  });
});

describe('message validation', () => {
  const base = { protocol: 'app-capability-bridge', version: 1, type: 'request', sender: 'app', sessionId: 's', generation: 1, messageId: 'm', sentAt: 1, requestId: 'r', method: 'echo', params: null };
  it('rejects unknown fields and getters without reading them', () => {
    expect(() => validateMessage({ ...base, surprise: true })).toThrow();
    const getter = vi.fn(() => 'x'); const bad = { ...base }; Object.defineProperty(bad, 'params', { enumerable: true, get: getter });
    expect(() => validateMessage(bad)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('creates an immutable safe snapshot', () => {
    const params = { nested: ['ok'] }; const message = validateMessage({ ...base, params }); params.nested[0] = 'changed';
    expect((message.params as any).nested[0]).toBe('ok'); expect(Object.isFrozen(message.params)).toBe(true);
  });
});