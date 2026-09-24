import { BridgeError, BridgeMessage, BridgeRole, BridgeState, BridgeTransport, DEFAULT_LIMITS, JsonValue, PROTOCOL, safeError, VERSION } from './contract';
import { validateMessage } from './validation';
import { diagnostic } from './diagnostics';

type Handler = (params: JsonValue, context: Readonly<{ requestId: string; operationId?: string; sessionId: string; generation: number }>) => JsonValue | Promise<JsonValue>;
type Pending = { resolve: (value: JsonValue) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout>; method: string; operationId?: string; startedAt: number };
export interface BridgeLimits { maxMessageUtf8Bytes: number; maxPending: number; maxQueue: number; maxInbound: number }
export interface BridgeCoreOptions { role: BridgeRole; transport: BridgeTransport; defaultTimeoutMs?: number; connectTimeoutMs?: number; readyRetryMs?: number; limits?: Partial<BridgeLimits>; sessionId?: string }

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export class BridgeCore {
  private state: BridgeState = 'idle';
  private generation = 0;
  private sessionId: string;
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Map<string, Pending>();
  private readonly queueOrder: string[] = [];
  private readonly queueEntries = new Map<string, BridgeMessage>();
  private readonly inbound = new Set<string>();
  private readonly eventHandlers = new Map<string, { event: string; handler: (payload: JsonValue, context: Readonly<{ subscriptionId: string; event: string; eventSeq: number; sessionId: string }>) => void; lastSeq: number }>();
  private readonly remoteSubscriptions = new Map<string, string>();
  private readonly eventSequence = new Map<string, number>();
  private startPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private readyTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyRequested = false;
  private lifecycleEpoch = 0;
  private readonly limits;

  constructor(private readonly options: BridgeCoreOptions) {
    this.sessionId = options.sessionId || id(options.role);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.register('bridge.event.subscribe', (params: any) => { if (!params || typeof params.subscriptionId !== 'string' || typeof params.event !== 'string') throw new BridgeError('INVALID_ARGUMENT', 'Invalid subscription'); this.remoteSubscriptions.set(params.subscriptionId, params.event); this.eventSequence.set(params.subscriptionId, 0); return { subscriptionId: params.subscriptionId }; });
    this.register('bridge.event.unsubscribe', (params: any) => { this.remoteSubscriptions.delete(params?.subscriptionId); this.eventSequence.delete(params?.subscriptionId); return { unsubscribed: true }; });
    this.register('bridge.event.deliver', (params: any) => { const entry = params && this.eventHandlers.get(params.subscriptionId); if (entry && entry.event === params.event && Number.isInteger(params.eventSeq) && params.eventSeq > entry.lastSeq) { entry.lastSeq = params.eventSeq; entry.handler(params.payload, Object.freeze({ subscriptionId: params.subscriptionId, event: params.event, eventSeq: params.eventSeq, sessionId: this.sessionId })); } return { delivered: !!entry }; });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new BridgeError('BRIDGE_FAILED', 'Bridge cannot be started'));
    this.state = 'starting';
    const epoch = ++this.lifecycleEpoch;
    this.startPromise = (async () => {
      try {
        await this.options.transport.start?.((message) => { void this.receive(message); });
        if (this.destroyRequested || epoch !== this.lifecycleEpoch) throw new BridgeError('BRIDGE_DESTROYED', 'Bridge is unavailable');
        this.state = 'connecting';
        if (this.options.role === 'h5') {
          await this.sendReady();
          if (this.destroyRequested || epoch !== this.lifecycleEpoch) throw new BridgeError('BRIDGE_DESTROYED', 'Bridge is unavailable');
          this.readyTimer = setInterval(() => void this.sendReady(), this.options.readyRetryMs ?? 500);
        }
        this.connectTimer = setTimeout(() => this.fail('CONNECT_TIMEOUT', 'Bridge connection timed out'), this.options.connectTimeoutMs ?? 15000);
      } catch (error) {
        if (!this.destroyRequested) this.fail('INITIALIZATION_FAILED', 'Bridge initialization failed');
        throw error instanceof BridgeError ? error : new BridgeError('INITIALIZATION_FAILED', 'Bridge initialization failed');
      }
    })();
    return this.startPromise;
  }

  register(method: string, handler: Handler): () => void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(method) || typeof handler !== 'function') throw new BridgeError('INVALID_MESSAGE', 'Invalid method registration');
    if (this.handlers.has(method)) throw new BridgeError('INVALID_MESSAGE', `Method already registered: ${method}`);
    this.handlers.set(method, handler);
    let active = true;
    return () => { if (active && this.handlers.get(method) === handler) this.handlers.delete(method); active = false; };
  }
  unregister(method: string): void { this.handlers.delete(method); }

  async subscribe(event: string, handler: (payload: JsonValue, context: Readonly<{ subscriptionId: string; event: string; eventSeq: number; sessionId: string }>) => void): Promise<string> {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(event) || typeof handler !== 'function') throw new BridgeError('INVALID_ARGUMENT', 'Invalid event subscription');
    const subscriptionId = id('subscription'); this.eventHandlers.set(subscriptionId, { event, handler, lastSeq: 0 });
    try { await this.call('bridge.event.subscribe', { subscriptionId, event }); return subscriptionId; } catch (error) { this.eventHandlers.delete(subscriptionId); throw error; }
  }
  async unsubscribe(subscriptionId: string): Promise<boolean> { const existed = this.eventHandlers.delete(subscriptionId); if (existed && this.state === 'ready') await this.call('bridge.event.unsubscribe', { subscriptionId }).catch(() => undefined); return existed; }
  async emit(event: string, payload: JsonValue = null): Promise<number> {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(event)) throw new BridgeError('INVALID_ARGUMENT', 'Invalid event');
    const tasks: Promise<JsonValue>[] = [];
    for (const [subscriptionId, subscribedEvent] of this.remoteSubscriptions) if (subscribedEvent === event) { const eventSeq = (this.eventSequence.get(subscriptionId) || 0) + 1; this.eventSequence.set(subscriptionId, eventSeq); tasks.push(this.call('bridge.event.deliver', { subscriptionId, event, eventSeq, payload })); }
    await Promise.all(tasks); return tasks.length;
  }

  call(method: string, params?: JsonValue, options: { timeoutMs?: number; operationId?: string } = {}): Promise<JsonValue> {
    if (!['idle', 'starting', 'connecting', 'ready'].includes(this.state)) return Promise.reject(new BridgeError('BRIDGE_DESTROYED', 'Bridge is unavailable'));
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(method)) return Promise.reject(new BridgeError('INVALID_MESSAGE', 'Invalid method'));
    if (this.pending.size >= this.limits.maxPending) return Promise.reject(new BridgeError('TOO_MANY_PENDING', 'Pending limit reached'));
    const requestId = id('request');
    const message = this.message('request', { requestId, method, ...(params === undefined ? {} : { params }), ...(options.operationId ? { operationId: options.operationId } : {}) });
    const startedAt = Date.now();
    diagnostic('RPC', 'send', { action: method, requestId, operationId: options.operationId });
    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => this.finishPending(requestId, new BridgeError('TIMEOUT', `Call timed out: ${method}`)), options.timeoutMs ?? this.options.defaultTimeoutMs ?? 15000);
      this.pending.set(requestId, { resolve, reject, timer, method, operationId: options.operationId, startedAt });
    });
    if (this.state === 'ready') void this.submitRequest(message); else {
      if (this.queueEntries.size >= this.limits.maxQueue) this.finishPending(requestId, new BridgeError('QUEUE_OVERFLOW', 'Queue limit reached'));
      else { this.queueOrder.push(requestId); this.queueEntries.set(requestId, message); }
    }
    return promise;
  }

  waitUntilReady(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(check); reject(new BridgeError('CONNECT_TIMEOUT', 'Bridge connection timed out')); }, options.timeoutMs ?? 15000);
      const check = setInterval(() => {
        if (this.state === 'ready') { clearTimeout(timeout); clearInterval(check); resolve(); }
        else if (['failed', 'destroying', 'destroyed'].includes(this.state)) { clearTimeout(timeout); clearInterval(check); reject(new BridgeError('BRIDGE_FAILED', 'Bridge is unavailable')); }
      }, 10);
    });
  }
  isReady(): boolean { return this.state === 'ready'; }
  getSnapshot() { return Object.freeze({ state: this.state, ready: this.isReady(), sessionId: this.sessionId, generation: this.generation, pending: this.pending.size, queued: this.queueEntries.size, inbound: this.inbound.size }); }

  async receive(input: unknown): Promise<void> {
    let message: Readonly<BridgeMessage>;
    try { message = validateMessage(input, this.limits.maxMessageUtf8Bytes); } catch { return; }
    if (message.sender === this.options.role) return;
    if (message.type === 'ready' && this.options.role === 'app' && (this.state === 'connecting' || this.state === 'ready')) {
      const newSession = this.state === 'ready' && message.sessionId !== this.sessionId;
      if (newSession) {
        for (const requestId of [...this.pending.keys()]) this.finishPending(requestId, new BridgeError('SESSION_REPLACED', 'H5 session was replaced'));
        this.queueEntries.clear(); this.queueOrder.length = 0; this.inbound.clear(); this.eventHandlers.clear(); this.remoteSubscriptions.clear(); this.eventSequence.clear();
        this.generation += 1;
      } else if (!this.generation) this.generation = 1;
      this.sessionId = message.sessionId;
      void this.options.transport.send(this.message('ready-ack', { accepted: true, capabilities: [], limits: this.limits }, this.generation));
      this.becomeReady(); return;
    }
    if (message.sessionId !== this.sessionId) return;
    if (message.type === 'ready-ack' && this.options.role === 'h5' && this.state === 'connecting') {
      if (message.accepted !== true || message.generation < 1) return void this.fail('SESSION_ACK_TIMEOUT', 'Bridge session rejected');
      this.generation = message.generation; this.becomeReady(); return;
    }
    if (this.state !== 'ready' || message.generation !== this.generation) return;
    if (message.type === 'response') this.handleResponse(message);
    else if (message.type === 'request') void this.handleRequest(message);
  }

  disconnect(reason = 'Bridge disconnected'): Promise<void> {
    if (this.state !== 'ready' || this.generation < 1) return Promise.resolve();
    try { return Promise.resolve(this.options.transport.send(this.message('disconnect', { reason }))).catch(() => undefined); }
    catch { return Promise.resolve(); }
  }

  destroy(reason = 'Bridge destroyed'): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyRequested = true;
    this.lifecycleEpoch += 1;
    this.destroyPromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      if (this.state === 'destroyed') return;
      this.state = 'destroying'; this.clearTimers();
      for (const requestId of [...this.pending.keys()]) this.finishPending(requestId, new BridgeError('BRIDGE_DESTROYED', reason));
      this.queueEntries.clear(); this.queueOrder.length = 0; this.inbound.clear(); this.eventHandlers.clear(); this.remoteSubscriptions.clear(); this.eventSequence.clear(); this.handlers.clear();
      try { await this.options.transport.destroy(); } finally { this.state = 'destroyed'; }
    })();
    return this.destroyPromise;
  }

  private message(type: BridgeMessage['type'], extra: Record<string, unknown>, generation = this.generation): BridgeMessage {
    return { protocol: PROTOCOL, version: VERSION, type, sender: this.options.role, sessionId: this.sessionId, generation, messageId: id('message'), sentAt: Date.now(), ...extra };
  }
  private async sendReady() { if (this.state === 'connecting') await this.options.transport.send(this.message('ready', { capabilitiesRequested: [] }, 0)); }
  private becomeReady() { this.state = 'ready'; this.clearTimers(); void this.flush(); }
  private clearTimers() { if (this.readyTimer) clearInterval(this.readyTimer); if (this.connectTimer) clearTimeout(this.connectTimer); this.readyTimer = this.connectTimer = null; }
  private fail(code: string, message: string) { if (['destroying', 'destroyed'].includes(this.state)) return; this.state = 'failed'; this.clearTimers(); for (const requestId of [...this.pending.keys()]) this.finishPending(requestId, new BridgeError(code, message)); }
  private finishPending(requestId: string, error?: BridgeError, result?: JsonValue) {
    const pending = this.pending.get(requestId); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(requestId); this.queueEntries.delete(requestId);
    diagnostic('RPC', 'response', { action: pending.method, requestId, operationId: pending.operationId, durationMs: Date.now() - pending.startedAt, code: error?.code || 'OK' }, error ? 'error' : 'info');
    error ? pending.reject(error) : pending.resolve(result ?? null);
  }
  private async submitRequest(message: BridgeMessage) { try { await this.options.transport.send(message); } catch { this.finishPending(message.requestId as string, new BridgeError('SEND_FAILED', 'Message submission failed')); } }
  private async flush() { for (const requestId of this.queueOrder.splice(0)) { const message = this.queueEntries.get(requestId); this.queueEntries.delete(requestId); if (message && this.pending.has(requestId) && this.state === 'ready') await this.submitRequest(message); } }
  private handleResponse(message: Readonly<BridgeMessage>) { const requestId = message.requestId as string; if (message.ok) this.finishPending(requestId, undefined, message.result as JsonValue); else { const remote = message.error as { code?: unknown; message?: unknown; data?: JsonValue }; this.finishPending(requestId, new BridgeError(typeof remote.code === 'string' ? remote.code : 'HANDLER_ERROR', typeof remote.message === 'string' ? remote.message : 'Remote error', remote.data)); } }
  private async handleRequest(message: Readonly<BridgeMessage>) {
    const requestId = message.requestId as string;
    if (this.inbound.has(requestId)) return;
    const handler = this.handlers.get(message.method as string);
    if (!handler) return void this.options.transport.send(this.message('response', { requestId, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Method not found' } }));
    if (this.inbound.size >= this.limits.maxInbound) return void this.options.transport.send(this.message('response', { requestId, ok: false, error: { code: 'BUSY', message: 'Handler limit reached' } }));
    this.inbound.add(requestId); const tokenGeneration = this.generation;
    try {
      const result = await handler(message.params as JsonValue, Object.freeze({ requestId, operationId: message.operationId as string | undefined, sessionId: this.sessionId, generation: tokenGeneration }));
      if (this.state === 'ready' && tokenGeneration === this.generation) await this.options.transport.send(this.message('response', { requestId, ok: true, result: result ?? null }));
    } catch (error) {
      const safe = safeError(error);
      if (this.state === 'ready' && tokenGeneration === this.generation) await this.options.transport.send(this.message('response', { requestId, ok: false, error: safe }));
    } finally { this.inbound.delete(requestId); }
  }
}