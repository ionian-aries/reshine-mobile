import { BridgeError, JsonValue } from '../bridge/contract';
import { TransferManager, TRANSFER_LIMITS } from '../bridge/transfer';
import { ensureH5Bridge, getH5TransferManager } from '../bridge/h5-lifecycle';
import { diagnostic } from '../bridge/diagnostics';

export const DIRECT_LIMIT_BYTES = 128 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

export function assertString(value: unknown, name: string, required = true, max = 8192): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new BridgeError('INVALID_ARGUMENT', `${name} 参数无效`);
  return value.trim();
}
export function assertInteger(value: unknown, name: string, min: number, max: number, fallback: number, allowed?: number[]): number {
  const result = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(result) || (result as number) < min || (result as number) > max || (allowed && !allowed.includes(result as number))) throw new BridgeError('INVALID_ARGUMENT', `${name} 参数无效`);
  return result as number;
}
export function assertFinite(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= min || value > max) throw new BridgeError('INVALID_ARGUMENT', `${name} 参数无效`);
  return value;
}
export function assertBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new BridgeError('INVALID_ARGUMENT', `${name} 参数无效`);
  return value;
}
export function assertImage(value: unknown): string {
  const image = assertString(value, 'image', true, 8 * 1024 * 1024);
  if (!HTTP_URL.test(image)) {
    const match = image.match(DATA_URL);
    if (!match || match[2].length % 4 !== 0) throw new BridgeError('INVALID_ARGUMENT', 'image 必须是 PNG/JPEG/WebP Data URL 或 HTTP(S) URL');
    const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0;
    if (match[2].length / 4 * 3 - padding > 5 * 1024 * 1024) throw new BridgeError('PAYLOAD_TOO_LARGE', '图片解码后不得超过 5 MiB');
  }
  return image;
}
let transferCore: unknown;
let transferManager: TransferManager | null = null;
function scaleDiagnostic(result: any): Record<string, unknown> {
  const data = result?.data;
  if (!data || typeof data !== 'object') return { weightPresent: false };
  const raw = typeof data.raw === 'string' ? data.raw : '';
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) { hash ^= raw.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return {
    weightPresent: Object.prototype.hasOwnProperty.call(data, 'weight'),
    weightType: typeof data.weight,
    weight: data.weight == null ? '' : String(data.weight),
    unit: data.unit,
    stable: data.stable,
    overload: data.overload,
    readingType: data.weightType,
    rawLength: raw.length,
    rawHash: raw ? (hash >>> 0).toString(16).padStart(8, '0') : '',
    rawNegative: /^(?:ST|US|OL),(?:NT|TR),-/.test(raw.trim()),
  };
}
function transfers(bridge: any): TransferManager {
  const lifecycle = getH5TransferManager();
  if (lifecycle) return lifecycle;
  if (transferCore !== bridge) { transferManager?.destroy(); transferCore = bridge; transferManager = new TransferManager(bridge); }
  return transferManager!;
}
export async function invokeWithImage<T extends JsonValue>(action: string, params: any, timeoutMs = 65000, operationId?: string): Promise<T> {
  const startedAt = Date.now();
  diagnostic('NASL', 'call.start', { action, imageBytes: typeof params?.image === 'string' ? params.image.length : 0 });
  try {
    const bridge = await ensureH5Bridge();
    if (!bridge) throw new BridgeError('BRIDGE_UNAVAILABLE', 'App Bridge 不可用');
    const manager = transfers(bridge);
    let next = params;
    const encodedLength = typeof TextEncoder === 'function' ? new TextEncoder().encode(params.image).length : unescape(encodeURIComponent(params.image)).length;
    if (typeof params.image === 'string' && !HTTP_URL.test(params.image) && encodedLength > DIRECT_LIMIT_BYTES) {
      diagnostic('NASL', 'transfer.start', { action, size: encodedLength });
      const descriptor = await manager.send(params.image, action);
      next = { ...params, image: '', imageAttachment: descriptor };
    }
    const received: any = await bridge.call(action, next, { timeoutMs, operationId });
    const attachment = action === 'printer_preview' && received?.data?.image?.kind === 'bridge-attachment'
      ? received.data.image
      : null;
    const result: any = attachment
      ? { ...received, data: { ...received.data, image: manager.consume(attachment, 'printer_preview') } }
      : received;
    diagnostic('NASL', 'call.success', { action, status: result?.status, code: result?.code, durationMs: Date.now() - startedAt });
    return result as T;
  } catch (error) {
    diagnostic('NASL', 'call.failure', { action, code: (error as any)?.code || 'ERROR', durationMs: Date.now() - startedAt }, 'error');
    throw error;
  }
}
export async function invoke<T extends JsonValue>(action: string, params?: JsonValue, timeoutMs = 15000): Promise<T> {
  const startedAt = Date.now();
  diagnostic('NASL', 'call.start', { action });
  try {
    const bridge = await ensureH5Bridge();
    if (!bridge) throw new BridgeError('BRIDGE_UNAVAILABLE', 'App Bridge 不可用');
    const result = await (params === undefined
      ? bridge.call(action)
      : bridge.call(action, params, { timeoutMs })) as T;
    diagnostic('NASL', 'call.success', { action, status: (result as any)?.status, code: (result as any)?.code, durationMs: Date.now() - startedAt, ...(action === 'scale_readWeight' ? scaleDiagnostic(result) : {}) });
    return result;
  } catch (error) {
    diagnostic('NASL', 'call.failure', { action, code: (error as any)?.code || 'ERROR', durationMs: Date.now() - startedAt }, 'error');
    throw error;
  }
}

export type LegacyEnvelope<T> = { status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: T };