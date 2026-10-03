export class UpgradeError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'UpgradeError'
    this.code = code
    this.data = options.data || null
    this.retryable = Boolean(options.retryable)
    this.phase = options.phase || 'idle'
  }
}

function redactUrl(value) {
  return String(value || '').replace(/(https?:\/\/[^\s?#]+)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, '$1?[REDACTED]')
}

function safeValue(value, depth = 0, seen = []) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactUrl(value)
  if (depth >= 4) return '[truncated]'
  if (typeof value !== 'object') return String(value)
  if (seen.indexOf(value) >= 0) return '[circular]'
  const nextSeen = seen.concat(value)
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1, nextSeen))
  return Object.keys(value).slice(0, 30).reduce((result, key) => {
    result[key] = /token|secret|password|authorization|cookie/i.test(key) ? '[REDACTED]' : safeValue(value[key], depth + 1, nextSeen)
    return result
  }, {})
}

function printable(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch (error) { return '[unserializable]' }
}

export function formatErrorDetails(error) {
  const value = error || {}
  const lines = [
    `code: ${redactUrl(value.code || 'UPDATE_FAILED')}`,
    `message: ${redactUrl(value.message || '更新失败')}`,
    `phase: ${redactUrl(value.phase || 'unknown')}`
  ]
  const runtimeInstall = value.data && value.data.runtimeInstall
  if (runtimeInstall) {
    lines.push(`plus.runtime.install.code: ${printable(safeValue(runtimeInstall.code))}`)
    lines.push(`plus.runtime.install.message: ${printable(safeValue(runtimeInstall.message))}`)
    lines.push(`plus.runtime.install.details: ${printable(safeValue(runtimeInstall.details))}`)
  } else if (value.data) {
    lines.push(`details: ${printable(safeValue(value.data))}`)
  }
  return lines.join('\n')
}

export function toUpgradeError(error, fallback) {
  if (error instanceof UpgradeError) return error
  const message = error && (error.errMsg || error.message)
  return new UpgradeError(fallback.code, message || fallback.message, {
    data: error || null,
    retryable: fallback.retryable,
    phase: fallback.phase
  })
}