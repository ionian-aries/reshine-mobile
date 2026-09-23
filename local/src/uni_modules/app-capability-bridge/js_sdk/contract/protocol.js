export const PROTOCOL = 'app-capability-bridge'
export const VERSION = 1
export const RECEIVER_NAME = '__APP_CAPABILITY_BRIDGE_RECEIVE__'
export const DEFAULT_LIMITS = Object.freeze({
  maxMessageUtf8Bytes: 128 * 1024,
  maxPending: 200,
  maxQueue: 100,
  maxInbound: 32
})
export const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/

export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export function safeError(error) {
  if (error instanceof BridgeError) return error.data === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, data: error.data }
  return { code: 'HANDLER_ERROR', message: 'Bridge handler failed' }
}