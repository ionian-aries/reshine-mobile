import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toPng: vi.fn(),
  invokeWithImage: vi.fn(async (_action: string, params: unknown) => ({ status: 'success', code: 'OK', message: '', data: params })),
}));
vi.mock('@zumer/snapdom', () => ({ snapdom: { toPng: mocks.toPng } }));
vi.mock('../../src/logics/capability-client', async () => {
  const actual: any = await vi.importActual('../../src/logics/capability-client');
  return { ...actual, invokeWithImage: mocks.invokeWithImage };
});

import { printer_capture, printer_preview, printer_print } from '../../src/logics/printer';
import * as publicLogics from '../../src/logics';

const PNG = 'data:image/png;base64,AAAA';
function target(ref = 'capture', visible = true) {
  const element = document.createElement('div');
  element.setAttribute('data-ref', ref);
  element.getBoundingClientRect = () => ({ width: visible ? 80 : 0, height: visible ? 40 : 0 } as DOMRect);
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  class RasterImage {
    naturalWidth = 80; naturalHeight = 40; width = 80; height = 40;
    set src(_value: string) { queueMicrotask(() => (this as any).onload?.()); }
  }
  ;(globalThis as any).Image = RasterImage;
  mocks.toPng.mockResolvedValue({ src: PNG });
});

describe('printer capture', () => {
  it('is exported by the printer module through the public index', () => {
    expect(publicLogics.printer_capture).toBe(printer_capture);
    const logicsDir = resolve(process.cwd(), 'src/logics');
    expect(existsSync(resolve(logicsDir, 'printer-capture.ts'))).toBe(false);
    const indexSource = readFileSync(resolve(logicsDir, 'index.ts'), 'utf8');
    expect(indexSource).toContain('printer_capture');
    expect(indexSource).not.toContain('printer-capture');
  });
  it('captures at scale 1 and returns the legacy shape', async () => {
    target();
    const result = await printer_capture('capture');
    expect(mocks.toPng).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ scale: 1, dpr: 1 }));
    expect(result).toEqual({ status: 'success', code: 'OK', message: '截图成功', data: { image: PNG, mimeType: 'image/png', pixelWidth: 80, pixelHeight: 40, byteLength: 3 } });
  });
  it('returns ref errors for empty, missing and hidden refs', async () => {
    expect((await printer_capture('')).code).toBe('INVALID_REF');
    expect((await printer_capture('missing')).code).toBe('REF_NOT_FOUND');
    target('hidden', false);
    expect((await printer_capture('hidden')).code).toBe('REF_NOT_VISIBLE');
  });
  it('returns RESOURCE_TIMEOUT when an image never loads', async () => {
    vi.useFakeTimers();
    const element = target('waiting'); element.appendChild(document.createElement('img'));
    const pending = printer_capture('waiting'); await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).code).toBe('RESOURCE_TIMEOUT'); vi.useRealTimers();
  });
  it('rejects captures exceeding 5 MiB', async () => {
    target('large'); mocks.toPng.mockResolvedValue({ src: `data:image/png;base64,${'A'.repeat(7_000_004)}` });
    expect((await printer_capture('large')).code).toBe('IMAGE_TOO_LARGE');
  });
});

describe('printer RPC parameters', () => {
  it('uses print defaults 80/40/90/180', async () => {
    await printer_print(PNG);
    expect(mocks.invokeWithImage).toHaveBeenCalledWith('printer_print', expect.objectContaining({ width: 80, height: 40, orientation: 90, threshold: 180 }), 65000, expect.any(String));
  });
  it('preview sends exactly image, width and height', async () => {
    await printer_preview(PNG, 80, 40);
    const payload = mocks.invokeWithImage.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ image: PNG, width: 80, height: 40 });
    expect(payload).not.toHaveProperty('orientation'); expect(payload).not.toHaveProperty('threshold');
  });
});