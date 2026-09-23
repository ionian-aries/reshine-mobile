import { BridgeError, METHOD_PATTERN, PROTOCOL, VERSION } from './protocol.js'

const TYPES = new Set(['ready', 'ready-ack', 'request', 'response'])
const BASE = ['protocol', 'version', 'type', 'sender', 'sessionId', 'generation', 'messageId', 'sentAt']
const EXTRA = {
  ready: ['capabilitiesRequested'],
  'ready-ack': ['accepted', 'capabilities', 'limits', 'error'],
  request: ['requestId', 'method', 'params', 'operationId'],
  response: ['requestId', 'ok', 'result', 'error']
}
const fail = message => { throw new BridgeError('INVALID_MESSAGE', message) }
const isPlain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const bytes = value => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).byteLength : unescape(encodeURIComponent(value)).length

function copyJson(value, depth, budget, ancestors) {
  if (depth > 16 || ++budget.nodes > 10000) fail('Message structure exceeds limits')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Non-finite number'); return value }
  if (typeof value !== 'object') fail('Only JSON values are allowed')
  if (ancestors.has(value)) fail('Circular value')
  ancestors.add(value)
  let output
  if (Array.isArray(value)) output = value.map(item => copyJson(item, depth + 1, budget, ancestors))
  else {
    if (!isPlain(value) || Object.getOwnPropertySymbols(value).length || Object.prototype.hasOwnProperty.call(value, 'toJSON')) fail('Unsafe object')
    output = Object.create(null)
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) fail('Accessor properties are forbidden')
      output[key] = copyJson(descriptor.value, depth + 1, budget, ancestors)
    }
  }
  ancestors.delete(value)
  return Object.freeze(output)
}
function stringField(value, name) { if (typeof value !== 'string' || !value.length || value.length > 256) fail(`Invalid ${name}`) }

export function validateMessage(input, maxBytes = 128 * 1024) {
  let parsed = input
  if (typeof input === 'string') {
    if (bytes(input) > maxBytes) throw new BridgeError('MESSAGE_TOO_LARGE', 'Message exceeds byte limit')
    try { parsed = JSON.parse(input) } catch (_) { fail('Invalid JSON') }
  }
  const message = copyJson(parsed, 0, { nodes: 0 }, new Set())
  if (bytes(JSON.stringify(message)) > maxBytes) throw new BridgeError('MESSAGE_TOO_LARGE', 'Message exceeds byte limit')
  if (message.protocol !== PROTOCOL || message.version !== VERSION) throw new BridgeError('PROTOCOL_MISMATCH', 'Unsupported bridge protocol')
  if (!TYPES.has(message.type) || !['h5', 'app'].includes(message.sender)) fail('Invalid type or sender')
  stringField(message.sessionId, 'sessionId'); stringField(message.messageId, 'messageId')
  if (!Number.isInteger(message.generation) || message.generation < 0 || !Number.isFinite(message.sentAt)) fail('Invalid generation or timestamp')
  const allowed = new Set(BASE.concat(EXTRA[message.type]))
  Object.keys(message).forEach(key => { if (!allowed.has(key)) fail(`Unknown field: ${key}`) })
  if (message.type === 'ready') {
    if (message.sender !== 'h5' || message.generation !== 0 || !Array.isArray(message.capabilitiesRequested) || message.capabilitiesRequested.some(v => typeof v !== 'string')) fail('Invalid ready')
  } else if (message.type === 'ready-ack') {
    if (message.sender !== 'app' || message.generation < 1 || typeof message.accepted !== 'boolean' || !Array.isArray(message.capabilities) || !isPlain(message.limits)) fail('Invalid ready acknowledgement')
  } else if (message.type === 'request') {
    stringField(message.requestId, 'requestId')
    if (typeof message.method !== 'string' || !METHOD_PATTERN.test(message.method)) fail('Invalid request')
    if (message.operationId !== undefined) stringField(message.operationId, 'operationId')
  } else {
    stringField(message.requestId, 'requestId')
    if (typeof message.ok !== 'boolean' || (message.ok ? !Object.prototype.hasOwnProperty.call(message, 'result') : !isPlain(message.error))) fail('Invalid response')
  }
  return message
}