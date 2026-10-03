import { describe, expect, it, vi } from 'vitest';
import { configureDiagnostics, diagnostic } from '../../src/bridge/diagnostics';

describe('diagnostics', () => {
  it('redacts identifiers and drops sensitive payload fields', () => {
    const sink = vi.fn(); configureDiagnostics({ enabled: true, logger: sink });
    diagnostic('Test', 'event', { requestId: 'request-secret-123456', token: 'secret-token', data: 'scan-body', size: 42 });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('scan-body');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('request-secret-123456');
    expect(sink.mock.calls[0][2].size).toBe(42);
  });
  it('serializes circular, bigint and sensitive diagnostics safely', () => {
    const sink = vi.fn(); configureDiagnostics({ enabled: true, logger: sink });
    const value: any = { count: 1n, token: 'secret', long: 'x'.repeat(600) }; value.self = value;
    diagnostic('Test', 'safe', { error: value });
    const text = sink.mock.calls[0][1];
    expect(text).toContain('[Circular]'); expect(text).toContain('1n'); expect(text).not.toContain('secret'); expect(text).toContain('[truncated]');
  });
  it('isolates logger failures', () => {
    configureDiagnostics({ enabled: true, logger: () => { throw new Error('logger failed'); } });
    expect(() => diagnostic('Test', 'event', { code: 'OK' })).not.toThrow();
  });
});