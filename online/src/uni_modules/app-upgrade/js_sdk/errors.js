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

export function toUpgradeError(error, fallback) {
  if (error instanceof UpgradeError) return error
  const message = error && (error.errMsg || error.message)
  return new UpgradeError(fallback.code, message || fallback.message, {
    data: error || null,
    retryable: fallback.retryable,
    phase: fallback.phase
  })
}