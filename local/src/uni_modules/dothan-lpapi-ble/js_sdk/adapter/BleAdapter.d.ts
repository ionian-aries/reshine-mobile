import { IBleAdapter, JobStartOptions, LPA_AdapterInitOptions, LPA_AuthorizeOptions, LPA_BleDeviceConnectOptions, LPA_BleDiscoveryOptions, LPA_ConnectionStateChangeResult, LPA_Device, LPA_DeviceRequestOptions, LPA_GattCharacteristic, LPA_GattService, LPA_GetCharacteristicsOptions, LPA_GetServicesOptions, LPA_NotifyCharacteristicOptions, LPA_ReadCharacteristicOptions, LPA_ReadResult, LPA_RequestOptions, LPA_Response, LPA_SetMtuOptions, LPA_SetMtuResult, LPA_WriteCharacteristicOptions } from "lpapi-ble";
import { IUniInitOptions } from "./UniContext";
type CharacteristicValueChangeListener = (result: UniNamespace.OnBLECharacteristicValueChangeSuccess) => void;
type BluetoothAdapterStateChangeListener = (result: UniNamespace.OnBluetoothAdapterStateChangeResult) => void;
export interface IBleAdapter2 {
    onBLECharacteristicValueChange?: (callback: CharacteristicValueChangeListener) => void;
    onBluetoothAdapterStateChange?: (callback: BluetoothAdapterStateChangeListener) => void;
}
export interface IUniAdapterInitOptions extends IUniInitOptions {
    bleAdapter?: IBleAdapter2;
}
export interface Uni_JobStartOptions extends JobStartOptions {
    canvasId: string;
}
export interface Uni_Base64SaveResult {
    target: string;
    width: number;
    height: number;
    size: number;
}
export interface IConnectionInfo {
    deviceId: string;
    connected: boolean;
    connectStateChange?: (res: LPA_ConnectionStateChangeResult) => void;
}
export declare class BleAdapter implements IBleAdapter {
    private static _instance?;
    private mConnectionMap;
    private mContext;
    private mDeviceInfo?;
    private mSystemInfo?;
    private mIsAdapterOpened?;
    private mShowWriteLog?;
    private mCharacteristicValueChangeMap?;
    private mCharacteristicMap;
    /**
     * 打印机链接状态变化回调函数。
     */
    private mConnectionStateChangeAction?;
    private mDeviceGetTimer?;
    /**
     * 蓝牙适配器状态变化通知回调函数。
     */
    private mAdapterStateChange?;
    private mAdapterStateChangeAction?;
    static getInstance(): BleAdapter;
    constructor(options?: IUniAdapterInitOptions);
    get isH5(): boolean | undefined;
    get Context(): IUniAdapterInitOptions;
    get platform(): string;
    protected isAndroid(): boolean;
    protected isHarmonyOS(): boolean;
    getDeviceInfo(): UniApp.GetDeviceInfoResult | undefined;
    protected androidAPILevel(): number;
    protected requestPermissions(): Promise<unknown>;
    /**
     * 蓝牙授权认证。
     */
    authorize(options?: LPA_AuthorizeOptions): Promise<LPA_Response<any>>;
    createAdapterStateChangeAction(): void;
    openAdapter(options?: LPA_AdapterInitOptions<any>): Promise<LPA_Response<any>>;
    private resetAllEventListener;
    closeAdapter(options?: LPA_RequestOptions<any>): Promise<LPA_Response<any>>;
    resetAdapter(options?: LPA_RequestOptions<any>): Promise<LPA_Response<any>>;
    startDiscovery(options?: LPA_BleDiscoveryOptions): Promise<LPA_Response<any>>;
    stopDiscovery(options?: LPA_RequestOptions<any>): Promise<LPA_Response<any>>;
    getFoundDevices(options?: LPA_RequestOptions<LPA_Device[]>): Promise<LPA_Response<LPA_Device[]>>;
    createConnectionStateChangeAction(): void;
    connect(options: LPA_BleDeviceConnectOptions): Promise<LPA_Response<any>>;
    private resetCharacteristicValueChange;
    disconnect(options: LPA_DeviceRequestOptions): Promise<LPA_Response<any>>;
    getConnectedDevices(options?: LPA_RequestOptions<LPA_Device[]>): Promise<LPA_Response<LPA_Device[]>>;
    setBleMtu(options: LPA_SetMtuOptions): Promise<LPA_SetMtuResult>;
    getGATTServices(options: LPA_GetServicesOptions): Promise<LPA_GattService[]>;
    getGATTCharacteristics(options: LPA_GetCharacteristicsOptions): Promise<LPA_GattCharacteristic[]>;
    onBLECharacteristicValueChange(characterId: string, callback: CharacteristicValueChangeListener): void;
    offBLECharacteristicValueChange(cid: string): void;
    read(options: LPA_ReadCharacteristicOptions): Promise<LPA_ReadResult>;
    notify(options: LPA_NotifyCharacteristicOptions): Promise<LPA_Response<any>>;
    write(options: LPA_WriteCharacteristicOptions): Promise<LPA_Response<any>>;
}
export {};
