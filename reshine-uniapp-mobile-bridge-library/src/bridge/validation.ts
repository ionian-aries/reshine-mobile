import { BridgeError, BridgeMessage, JsonValue, PROTOCOL, VERSION } from './contract';

const METHOD = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const TYPES = new Set(['ready', 'ready-ack', 'request', 'response', 'disconnect']);
const BASE = ['protocol', 'version', 'type', 'sender', 'sessionId', 'generation', 'messageId', 'sentAt'];
const EXTRA: Record<string, string[]> = {
  ready: ['capabilitiesRequested'],
  'ready-ack': ['accepted', 'capabilities', 'limits', 'error'],
  request: ['requestId', 'method', 'params', 'operationId'],
  response: ['requestId', 'ok', 'result', 'error'],
  disconnect: ['reason'],
};

function fail(message: string): never { throw new BridgeError('INVALID_MESSAGE', message); }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshot(value: unknown, depth: number, budget: { nodes: number }): JsonValue {
  if (depth > 16 || ++budget.nodes > 10000) fail('Message structure exceeds limits');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Non-finite number');
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, depth + 1, budget))) as JsonValue;
  if (!plain(value)) fail('Only plain JSON objects are allowed');
  if (Object.getOwnPropertySymbols(value).length) fail('Symbol keys are forbidden');
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) fail('Custom toJSON is forbidden');
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) fail('Accessor properties are forbidden');
    output[key] = snapshot(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(output);
}

function stringField(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) fail(`Invalid ${name}`);
}

export function validateMessage(input: unknown, maxBytes = 128 * 1024): Readonly<BridgeMessage> {
  let parsed = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > maxBytes) throw new BridgeError('MESSAGE_TOO_LARGE', 'Message exceeds byte limit');
    try { parsed = JSON.parse(input); } catch { fail('Invalid JSON'); }
  }
  const copy = snapshot(parsed, 0, { nodes: 0 }) as unknown as BridgeMessage;
  const encoded = JSON.stringify(copy);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new BridgeError('MESSAGE_TOO_LARGE', 'Message exceeds byte limit');
  if (copy.protocol !== PROTOCOL || copy.version !== VERSION) throw new BridgeError('PROTOCOL_MISMATCH', 'Unsupported bridge protocol');
  if (!TYPES.has(copy.type) || (copy.sender !== 'h5' && copy.sender !== 'app')) fail('Invalid type or sender');
  stringField(copy.sessionId, 'sessionId'); stringField(copy.messageId, 'messageId');
  if (!Number.isInteger(copy.generation) || copy.generation < 0 || !Number.isFinite(copy.sentAt)) fail('Invalid generation or timestamp');
  const allowed = new Set([...BASE, ...EXTRA[copy.type]]);
  for (const key of Object.keys(copy)) if (!allowed.has(key)) fail(`Unknown field: ${key}`);
  if (copy.type === 'ready') {
    if (copy.sender !== 'h5' || copy.generation !== 0 || !Array.isArray(copy.capabilitiesRequested)) fail('Invalid ready');
  } else if (copy.type === 'ready-ack') {
    if (copy.sender !== 'app' || copy.generation < 1 || typeof copy.accepted !== 'boolean' || !Array.isArray(copy.capabilities)) fail('Invalid ready acknowledgement');
  } else if (copy.type === 'request') {
    stringField(copy.requestId, 'requestId');
    if (typeof copy.method !== 'string' || !METHOD.test(copy.method)) fail('Invalid method');
    if (copy.operationId !== undefined) stringField(copy.operationId, 'operationId');
  } else if (copy.type === 'disconnect') {
    if (copy.generation < 1 || (copy.reason !== undefined && typeof copy.reason !== 'string')) fail('Invalid disconnect');
  } else {
    stringField(copy.requestId, 'requestId');
    if (typeof copy.ok !== 'boolean') fail('Invalid response');
    if (copy.ok ? !Object.prototype.hasOwnProperty.call(copy, 'result') : !plain(copy.error)) fail('Invalid response body');
  }
  return copy;
}