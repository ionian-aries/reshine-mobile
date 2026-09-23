import { DrawContext, DrawItemExtOptions, DrawPageItems, LabelAttachOptions, LabelContext, LPA_InitOptions, LPA_JsonPrintOption, LPA_Response, LPAPI } from "lpapi-ble";
import { IUniAdapterInitOptions } from "./adapter/BleAdapter";
import { IUniCanvasInitOptions } from "./adapter/UniContext";
export interface InitOptions extends IUniCanvasInitOptions, IUniAdapterInitOptions, LPA_InitOptions {
    /** 注入外部 BLE 适配器；用于 shared 所有权模式。 */
    adapter?: any;
    ownership?: "exclusive" | "shared";
}
export interface InitUniOptions extends InitOptions {
    callback: (api: LPAPI, res: LPA_Response<any>) => void;
}
export declare class LPAPIFactory {
    private static api?;
    /**
     * 获取LPAPI接口实例。
     */
    static getInstance(options?: InitOptions): LPAPI;
    static initApi(options?: InitUniOptions): Promise<LPAPI>;
    static resetApi(options?: InitOptions): Promise<LPAPI>;
    static createInstance(options?: InitOptions): LPAPI;
}
export interface IUniLabelAttachOptions extends LabelAttachOptions {
    canvasId?: string;
}
export declare class UniPreview extends LabelContext {
    constructor(options: LabelCreateOptions);
    protected createDrawContext(options: IUniLabelAttachOptions): DrawContext;
    attachTo(options: IUniLabelAttachOptions): Promise<boolean>;
}
export type DefineConfigFunc<T> = () => T;
export type DefineConfigOptions<T> = T | DefineConfigFunc<T>;
export declare function definePrintConfig(options: LPA_JsonPrintOption): LPA_JsonPrintOption;
export declare function definePrintConfig(callback: () => LPA_JsonPrintOption): () => LPA_JsonPrintOption;
export declare function definePageConfig(page: DrawPageItems): DrawPageItems;
export declare function defineDrawConfig(options: DrawItemExtOptions): DrawItemExtOptions;
export * from "lpapi-ble";
