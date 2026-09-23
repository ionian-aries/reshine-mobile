import { createDiagnosticLogger } from '../js_sdk/diagnostics.js'

describe('App diagnostics', () => {
  test('redacts sensitive values and isolates logger failures', () => {
    const calls = []
    const log = createDiagnosticLogger({ logger: (...args) => calls.push(args) })
    log('BridgeCore', 'receive.drop', { sessionId: 'session-secret-123', rawFrame: 'private', scanText: 'barcode', reason: 'generation' })
    const text = JSON.stringify(calls)
    expect(text).not.toContain('session-secret-123')
    expect(text).not.toContain('private')
    expect(text).not.toContain('barcode')
    expect(text).toContain('generation')
    log('Action', 'error', { errorMessage: 'request failed at https://private.example/path?token=secret', password: 'secret', requestId: 'request-secret-123' }, 'error')
    const errorText = calls[calls.length - 1][1]
    expect(errorText).toContain('request failed at [URL]')
    expect(errorText).not.toContain('[object Object]')
    expect(errorText).not.toContain('private.example')
    expect(errorText).not.toContain('"password":"secret"')
    expect(() => createDiagnosticLogger({ logger: () => { throw new Error('broken') } })('Test', 'event')).not.toThrow()
  })
})