export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticLogger = (level: DiagnosticLevel, message: string, detail?: Record<string, unknown>) => void;

const PREFIX = '[ACB:H5]';
let enabled = true;
let sink: DiagnosticLogger | null = null;

export function configureDiagnostics(options: { enabled?: boolean; logger?: DiagnosticLogger } = {}): void {
  if (typeof options.enabled === 'boolean') enabled = options.enabled;
  if (options.logger) sink = options.logger;
}

export function shortId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= 8 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitize(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 5) return '[MaxDepth]';
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return { code: (value as any).code || 'ERROR', message: value.message.slice(0, 300) };
  if (value === null || typeof value !== 'object') return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…[truncated]` : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output: any = Array.isArray(value) ? [] : {};
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.slice(0, 50).map((item, index) => [index, item])
    : Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).slice(0, 50);
  for (const [key, item] of entries) output[key] = /^(params|result|data|image|rawFrame|token|payload|chunk|scanText|password|secret)$/i.test(String(key)) ? '[REDACTED]' : sanitize(item, depth + 1, seen);
  seen.delete(value);
  return output;
}
export function safeStableJson(value: unknown, maxLength = 4000, space = 0): string {
  try {
    const sanitized = sanitize(value);
    const text = JSON.stringify(sanitized, null, space);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
  } catch (_) { return '"[Unserializable]"'; }
}

export function diagnostic(module: string, event: string, detail: Record<string, unknown> = {}, level: DiagnosticLevel = 'info'): void {
  if (!enabled) return;
  const safe: Record<string, unknown> = {};
  const blocked = /^(params|result|data|image|rawFrame|token|payload|chunk|scanText)$/i;
  for (const [key, value] of Object.entries(detail)) {
    if (blocked.test(key)) continue;
    if (/(session|request|transfer|device).*id/i.test(key)) safe[key] = shortId(value);
    else if (value instanceof Error) safe[key] = { code: (value as any).code || 'ERROR', message: value.message };
    else safe[key] = value;
  }
  try {
    const rendered = safeStableJson(safe);
    if (sink) sink(level, `${PREFIX}[${module}] ${event} ${rendered}`, safe);
    else {
      const target = typeof console !== 'undefined' && (console[level] || console.log);
      if (target) target.call(console, `${PREFIX}[${module}] ${event} ${rendered}`);
    }
  } catch (_) { /* diagnostics must never affect business */ }
}