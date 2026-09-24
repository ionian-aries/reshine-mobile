import { describe, expect, it, vi, afterEach } from 'vitest';
import { bridge_destroy, bridge_init } from '../../src/logics/bridge';
import { assertBoolean, assertFinite, assertImage, assertInteger, assertString, DIRECT_LIMIT_BYTES, invokeWithImage } from '../../src/logics/capability-client';
import { configureDiagnostics } from '../../src/bridge/diagnostics';
import * as bluetooth from '../../src/logics/bluetooth';
import * as scale from '../../src/logics/scale';
import * as printer from '../../src/logics/printer';
import * as scan from '../../src/logics/scan';
import * as lifecycle from '../../src/bridge/h5-lifecycle';

describe('H5 capability validation', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('keeps restored bridge_init positional arguments from shifting an owner token into sdkUrl', async () => {
    const init = vi.spyOn(lifecycle, 'initH5Bridge').mockResolvedValue({ ready: true, state: 'ready', env: 'app', isApp: true, source: 'app-handshake', owners: 1 });
    await bridge_init(undefined, 5000);
    expect(init).toHaveBeenCalledWith({ ownerToken: 'legacy-owner', sdkUrl: undefined, sdkTimeoutMs: 5000, connectTimeoutMs: 5000 });
    const destroy = vi.spyOn(lifecycle, 'destroyH5Bridge').mockResolvedValue({ destroyed: true, remainingOwners: 0 });
    await bridge_destroy();
    expect(destroy).toHaveBeenCalledWith(undefined);
  });
  it('keeps strict primitive types and defaults', () => {
    expect(assertInteger(undefined, 'timeout', 100, 60000, 5000)).toBe(5000);
    expect(assertBoolean(undefined, 'excludeUnnamed', true)).toBe(true);
    expect(() => assertInteger('5000', 'timeout', 100, 60000, 5000)).toThrowError(/参数无效/);
    expect(() => assertFinite(NaN, 'width', 0, 1000)).toThrowError(/参数无效/);
    expect(() => assertString('', 'deviceId')).toThrowError(/参数无效/);
  });
  it('accepts URLs and transferable images, rejecting invalid paths and over 5 MiB', () => {
    expect(assertImage('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(assertImage(`data:image/png;base64,${'A'.repeat(DIRECT_LIMIT_BYTES)}`)).toContain('data:image/png');
    expect(() => assertImage(`data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}`)).toThrowError(/5 MiB/);
    expect(() => assertImage('file:///tmp/a.png')).toThrowError(/Data URL/);
  });
  it('logs the H5 scale value and only a raw fingerprint', async () => {
    const sink = vi.fn();
    const call = vi.fn(async () => ({ status: 'success', code: 'OK', message: '', data: { weight: '-1.25', unit: 'kg', stable: true, overload: false, weightType: 'net', raw: 'ST,NT,-123456789.00kg' } }));
    configureDiagnostics({ enabled: true, logger: sink });
    vi.spyOn(lifecycle, 'ensureH5Bridge').mockResolvedValue({ call } as any);
    await scale.scale_readWeight(5000 as any);
    const text = JSON.stringify(sink.mock.calls);
    expect(text).toContain('-1.25');
    expect(text).toContain('rawLength');
    expect(text).toContain('rawHash');
    expect(text).not.toContain('ST,NT,-123456789.00kg');
  });
  it('rebuilds a frozen printer preview envelope without mutating its attachment placeholder', async () => {
    const descriptor = Object.freeze({ kind: 'bridge-attachment', transferId: 'preview-1', action: 'printer_preview', field: 'image', mime: 'image/png', decodedBytes: 8, sha256: 'a'.repeat(64) });
    const data = Object.freeze({ image: descriptor, retained: 'field' });
    const response = Object.freeze({ status: 'success', code: 'OK', message: '', data });
    const call = vi.fn(async () => response);
    const consume = vi.fn(() => 'data:image/png;base64,iVBORw0KGgo=');
    vi.spyOn(lifecycle, 'ensureH5Bridge').mockResolvedValue({ call } as any);
    vi.spyOn(lifecycle, 'getH5TransferManager').mockReturnValue({ consume } as any);

    const result = await invokeWithImage<any>('printer_preview', { image: 'https://example.com/a.png', width: 80, height: 40 });

    expect(result).toEqual({ status: 'success', code: 'OK', message: '', data: { image: 'data:image/png;base64,iVBORw0KGgo=', retained: 'field' } });
    expect(result).not.toBe(response); expect(result.data).not.toBe(data);
    expect(response.data.image).toBe(descriptor);
    expect(consume).toHaveBeenCalledOnce(); expect(consume).toHaveBeenCalledWith(descriptor, 'printer_preview');
  });
  it('preserves frozen printer preview error envelopes without consuming attachments', async () => {
    const response = Object.freeze({ status: 'error', code: 'ERROR_GET_IMAGE_DATA', message: '预览失败', data: Object.freeze({ image: '' }) });
    const call = vi.fn(async () => response);
    const consume = vi.fn();
    vi.spyOn(lifecycle, 'ensureH5Bridge').mockResolvedValue({ call } as any);
    vi.spyOn(lifecycle, 'getH5TransferManager').mockReturnValue({ consume } as any);

    await expect(invokeWithImage<any>('printer_preview', { image: 'https://example.com/a.png', width: 80, height: 40 })).resolves.toBe(response);
    expect(consume).not.toHaveBeenCalled();
  });
  it.each([
    ['bluetooth_getState', bluetooth.bluetooth_getState],
    ['bluetooth_enable', bluetooth.bluetooth_enable],
    ['bluetooth_disable', bluetooth.bluetooth_disable],
    ['scale_disconnect', scale.scale_disconnect],
    ['scale_status', scale.scale_status],
    ['printer_disconnect', printer.printer_disconnect],
    ['printer_status', printer.printer_status],
    ['scan_cancel', scan.scan_cancel],
  ])('omits params for no-argument action %s', async (action, logic) => {
    const call = vi.fn(async () => ({ status: 'success', code: 'OK', message: '', data: {} }));
    vi.spyOn(lifecycle, 'ensureH5Bridge').mockResolvedValue({ call } as any);
    await logic();
    expect(call).toHaveBeenCalledWith(action);
  });
});