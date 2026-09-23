export interface BluetoothState {
  supported: boolean;
  permissionGranted: boolean;
  systemEnabled: boolean;
  appSessionOpened: boolean;
  discovering: boolean;
  connectedDeviceCount: number;
}

export interface BleDevice {
  deviceId: string;
  name?: string;
  localName?: string;
  RSSI?: number;
  advertisServiceUUIDs?: string[];
  advertisData?: ArrayBuffer;
  lastSeenAt?: number;
  [key: string]: any;
}

export interface ScanOptions {
  nameContains?: string;
  serviceUUIDs?: string[];
  minRssi?: number;
  timeout?: number;
  allowDuplicatesKey?: boolean;
}

export interface ScanHandle {
  scanId: string;
  devices: BleDevice[];
  discovering: boolean;
}

export interface PhysicalConnectionState {
  deviceId: string;
  deviceType?: string;
  owner?: string;
  owners?: string[];
  connected: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'failed';
  lastError?: PublicError;
}

export interface PublicError {
  code: string;
  message: string;
  operationId?: string;
  recoverable?: boolean;
}

export type BleEventName = 'stateChanged' | 'scanStateChanged' | 'deviceFound' | 'error';

export interface BlePublicApi {
  initialize(): Promise<BluetoothState>;
  getBluetoothState(): Promise<BluetoothState>;
  requestEnableSystemBluetooth(): Promise<BluetoothState>;
  requestDisableSystemBluetooth(options?: { force?: boolean }): Promise<BluetoothState>;
  startScan(options?: ScanOptions): Promise<ScanHandle>;
  stopScan(scanId: string): Promise<void>;
  on(eventName: BleEventName, handler: (payload: any) => void): () => void;
}

export interface BleAppLifecycle {
  shutdown(): Promise<void>;
}

export interface PrinterDevice extends BleDevice {
  deviceType: 'printer';
}

export interface PrinterBusinessState {
  state: 'disconnected' | 'connecting' | 'ready' | 'printing' | 'disconnecting' | 'failed';
  connected: boolean;
  ready: boolean;
  printing: boolean;
  printer: (PrinterDevice & Record<string, any>) | null;
  lastError?: PublicError | null;
}

export interface PrinterPrintJob {
  image: string;
  canvasId?: string;
  width: number;
  height: number;
  orientation?: 0 | 90 | 180 | 270;
  copies?: number;
  gapType?: number;
  darkness?: number;
  speed?: number;
  threshold?: number;
  jobName?: string;
  onCanvasResize?: (canvas: { width?: number; height?: number }) => void | Promise<void>;
}

export interface PrinterPreviewResult {
  dataUrl: string;
  result: any;
}

export interface PrinterPublicApi {
  startDiscovery(options?: ScanOptions): Promise<ScanHandle>;
  stopDiscovery(scanId?: string): Promise<void>;
  connect(options: { deviceId: string; name?: string; timeout?: number; canvasId?: string }): Promise<PrinterBusinessState>;
  disconnect(): Promise<{ disconnected: boolean; deviceId?: string }>;
  getState(): Promise<PrinterBusinessState>;
  preview(job: PrinterPrintJob): Promise<PrinterPreviewResult>;
  print(job: PrinterPrintJob): Promise<{ submitted: boolean; result: any; printer: PrinterDevice | null }>;
  on(eventName: 'discoveryStateChanged' | 'deviceFound' | 'stateChanged' | 'error', handler: (payload: any) => void): () => void;
  off(eventName: string, handler: (payload: any) => void): void;
}

export interface ScaleDevice extends BleDevice {
  deviceType: 'scale';
  profileId: string;
  identityVerified: boolean;
  identityReasons: string[];
}

export interface WeightReading {
  raw: number | null;
  rawWeight: string;
  value: number | null;
  unit: 'kg' | 'g' | 'lb' | 'oz';
  stable: boolean;
  overloaded: boolean;
  negative: boolean;
  sign: '+' | '-';
  valid: boolean;
  weightType: 'NT' | 'TR';
  weightTypeMeaning: 'net' | 'tare';
  status: 'stable' | 'unstable' | 'overload';
  rawFrame: string;
  timestamp: number;
  receivedAt: number;
  sequence: number;
  deviceId: string;
  serviceId?: string;
  characteristicId?: string;
}

export interface ScaleBusinessState {
  state: 'disconnected' | 'connecting' | 'discovering' | 'ready' | 'disconnecting' | 'failed';
  connected: boolean;
  ready: boolean;
  occupied: boolean;
  identityVerified: boolean;
  device: ScaleDevice | null;
  serviceId: string;
  notifyCharacteristicId: string;
  writeCharacteristicId: string;
  lastError?: PublicError | null;
}

export interface ScaleDiscoveryOptions {
  timeout?: number;
}

export interface ScaleScanHandle extends ScanHandle {
  devices: ScaleDevice[];
}

export interface ScalePublicApi {
  startDiscovery(options?: ScaleDiscoveryOptions): Promise<ScaleScanHandle>;
  stopDiscovery(): Promise<void>;
  connect(deviceId: string): Promise<ScaleBusinessState>;
  disconnect(): Promise<{ disconnected: boolean; deviceId?: string }>;
  getState(): Promise<ScaleBusinessState>;
  readWeight(timeout?: number): Promise<WeightReading>;
  on(eventName: 'discoveryStateChanged' | 'deviceFound' | 'stateChanged' | 'rawFrame' | 'gattDiscovered' | 'probeLog' | 'error', handler: (payload: any) => void): () => void;
  off(eventName: string, handler: (payload: any) => void): void;
}

declare const plugin: { ble: BlePublicApi; printer: PrinterPublicApi; scale: ScalePublicApi };
export const ble: BlePublicApi;
export const printer: PrinterPublicApi;
export const scale: ScalePublicApi;
export const lifecycle: BleAppLifecycle;
export default plugin;