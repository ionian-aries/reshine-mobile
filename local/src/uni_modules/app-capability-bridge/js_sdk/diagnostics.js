const PREFIX = '[ACB:APP]'
const blocked = /^(params|result|data|image|rawFrame|token|payload|chunk|scanText|password|secret)$/i
export function shortId(value) {
  if (typeof value !== 'string' || !value) return undefined
  return value.length <= 8 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`
}
function safeUrl(value) {
  if (typeof value !== 'string' || !value) return undefined
  if (/^https?:\/\//i.test(value)) { try { const parsed = new URL(value); return `${parsed.protocol}//${parsed.host}${parsed.pathname}` } catch (_) {} }
  const normalized = value.replace(/^file:\/\//i, '').replace(/\\/g, '/')
  return normalized.length > 80 ? `…${normalized.slice(-80)}` : normalized
}
function safeMessage(value) {
  if (typeof value !== 'string') return value
  return value.replace(/https?:\/\/\S+/gi, '[URL]').replace(/(?:token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]').slice(0, 300)
}
function safeJson(value, maxLength = 4000) {
  const seen = []
  const visit = (input, depth = 0) => {
    if (depth > 5) return '[MaxDepth]'
    if (typeof input === 'bigint') return `${input}n`
    if (input instanceof Error) return { code: input.code || 'ERROR', message: String(input.message || '').slice(0, 300) }
    if (!input || typeof input !== 'object') return typeof input === 'string' && input.length > 500 ? `${input.slice(0, 500)}…[truncated]` : input
    if (seen.includes(input)) return '[Circular]'
    seen.push(input)
    const output = Array.isArray(input) ? [] : {}
    const entries = (Array.isArray(input) ? input.slice(0, 50).map((item, index) => [index, item]) : Object.keys(input).sort().slice(0, 50).map(key => [key, input[key]]))
    entries.forEach(([key, item]) => { output[key] = blocked.test(String(key)) ? '[REDACTED]' : visit(item, depth + 1) })
    seen.pop(); return output
  }
  try { const text = JSON.stringify(visit(value)); return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text } catch (_) { return '"[Unserializable]"' }
}
export { safeJson }
export function createDiagnosticLogger(options = {}) {
  const enabled = options.enabled !== false
  const sink = options.logger
  return (module, event, detail = {}, level = 'info') => {
    if (!enabled) return
    const safe = {}
    Object.keys(detail).forEach(key => {
      const value = detail[key]
      if (blocked.test(key)) return
      safe[key] = /url$/i.test(key) ? safeUrl(value) : (/(session|request|transfer|device|webview).*id/i.test(key) ? shortId(value) : (value instanceof Error ? { code: value.code || 'ERROR', message: safeMessage(value.message) } : (value && typeof value === 'object' ? undefined : (/message$/i.test(key) ? safeMessage(value) : value))))
    })
    try {
      const rendered = safeJson(safe)
      if (typeof sink === 'function') sink(level, `${PREFIX}[${module}] ${event} ${rendered}`, safe)
      else if (typeof console !== 'undefined') (console[level] || console.log).call(console, `${PREFIX}[${module}] ${event} ${rendered}`)
    } catch (_) {}
  }
}