export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type LegacyStatus = 'success' | 'error' | 'unsupported'
export interface LegacyEnvelope<T = Record<string, JsonValue>> { status: LegacyStatus; code: string; message: string; data: T }
export interface BluetoothDevice { deviceId: string; name: string; localName: string; rssi: number; connected: boolean; paired: boolean }
export interface AttachmentDescriptor { kind: 'bridge-attachment'; transferId: string; action: 'printer_print' | 'printer_preview'; field: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; decodedBytes: number; sha256: string }
export interface PrintParams { image: string; imageAttachment?: AttachmentDescriptor; width: number; height: number; orientation?: 0 | 90 | 180 | 270; threshold?: number }
export interface PrinterPrintParams extends PrintParams { copies?: number; gapType?: 0 | 1 | 2 | 3 | 4 | 255; printDarkness?: number; printSpeed?: number }
export interface BridgeSnapshot { state: string; ready: boolean; sessionId: string; generation: number; pending: number; queued: number; inbound: number }
export interface CallOptions { timeoutMs?: number; operationId?: string }
export interface Bridge {
  start(): Promise<void>
  destroy(reason?: string): Promise<void>
  cancelScan(reason?: string): Promise<LegacyEnvelope>
  register(method: string, handler: (params: JsonValue, context: Readonly<Record<string, unknown>>) => JsonValue | Promise<JsonValue>): () => void
  unregister(method: string): void
  subscribe(event: string, handler: (payload: JsonValue, context: Readonly<{ subscriptionId: string; event: string; eventSeq: number; sessionId: string }>) => void): Promise<string>
  unsubscribe(subscriptionId: string): Promise<boolean>
  emit(event: string, payload?: JsonValue): Promise<number>
  call(method: string, params?: JsonValue, options?: CallOptions): Promise<JsonValue>
  waitUntilReady(options?: { timeoutMs?: number }): Promise<void>
  getSnapshot(): BridgeSnapshot
}
export interface BusinessActionMap {
  scan_start(params?: { softTrigger?: boolean; timeout?: number; profile?: string; scanner?: 'internal' | 'external' | 'auto' }): Promise<LegacyEnvelope<{ data: string; codeId: string; aimId: string; charset: string }>>
  scan_cancel(params?: { reason?: string }): Promise<LegacyEnvelope>
  bluetooth_getState(params?: Record<string, never>): Promise<LegacyEnvelope<{ enabled: boolean }>>
  bluetooth_enable(params?: Record<string, never>): Promise<LegacyEnvelope<{ enabled: boolean; pending: boolean }>>
  bluetooth_disable(params?: Record<string, never>): Promise<LegacyEnvelope<{ enabled: boolean; pending: boolean }>>
  bluetooth_search(params?: { name?: string; timeout?: number; excludeUnnamed?: boolean }): Promise<LegacyEnvelope<{ devices: BluetoothDevice[] }>>
  scale_connect(params: { deviceId: string }): Promise<LegacyEnvelope>
  scale_disconnect(params?: Record<string, never>): Promise<LegacyEnvelope>
  scale_status(params?: Record<string, never>): Promise<LegacyEnvelope>
  scale_readWeight(params?: { timeout?: number }): Promise<LegacyEnvelope>
  printer_connect(params: { deviceId: string; name?: string; timeout?: number }): Promise<LegacyEnvelope>
  printer_disconnect(params?: Record<string, never>): Promise<LegacyEnvelope>
  printer_status(params?: Record<string, never>): Promise<LegacyEnvelope>
  printer_print(params: PrinterPrintParams): Promise<LegacyEnvelope>
  printer_preview(params: PrintParams): Promise<LegacyEnvelope<{ image: string | AttachmentDescriptor }>>
}
export const BUSINESS_CAPABILITIES: readonly (keyof BusinessActionMap)[]
export function createBusinessActions(options: { canvasId: string; adapter?: Record<string, unknown> }): { actions: BusinessActionMap; dispose(): Promise<void> }
export function registerBusinessActions(bridge: Bridge, options: { canvasId: string; adapter?: Record<string, unknown> }): { actions: BusinessActionMap; dispose(): Promise<void> }
export function install(Vue: { component(name: string, component: unknown): void }): void
export const AppCapabilityBridgeShell: unknown
export interface BridgeSource { src: string; kind: 'remote' | 'local'; origin: string | null }
export function parseBridgeSource(value: unknown): BridgeSource
export function createShellLifecycle(handlers?: Record<string, Function>): { show(): boolean; hide(reason?: string): boolean; destroy(reason?: string): Promise<void>; isVisible(): boolean; isDestroyed(): boolean }
export function resolveWebViewCandidate(children: unknown[], expectedId?: string): unknown
export function waitForWebView(resolve: () => unknown, options?: { attempts?: number; delayMs?: number }): Promise<unknown>
export function attachRuntimeLifecycle(options: Record<string, unknown>): () => void
export function createAppBridge(options: Record<string, unknown>): Bridge
export class BridgeError extends Error { code: string; data?: JsonValue }