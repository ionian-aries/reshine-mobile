import { CreateCanvasOptions, DrawContext, DzImage, ImageLoadOptions, JobStartOptions, JobStartResult, PageEndResult } from "lpapi-ble";
export interface IUniInitOptions {
    isWeiXin?: boolean;
    isAlipay?: boolean;
    isDingTalk?: boolean;
    isH5?: boolean;
    isAppPlus?: boolean;
}
export interface IUniCanvasInitOptions extends IUniInitOptions {
    canvasId?: string;
    canvas?: HTMLCanvasElement;
    drawTimeout?: number;
    componentInstance?: any;
}
export interface IUniCanvasContext extends CreateCanvasOptions, IUniCanvasInitOptions {
    canvasId?: string;
    canvas?: HTMLCanvasElement;
    drawTimeout?: number;
    componentInstance?: any;
}
export interface IUniCanvas {
    width: number;
    height: number;
    getContext(contextId: "2d"): UniNamespace.CanvasContext;
}
export interface Uni_Base64SaveResult {
    target: string;
    width: number;
    height: number;
    size: number;
}
export declare class UniContext extends DrawContext {
    static createInstance(options: IUniCanvasContext, prevContext?: DrawContext): UniContext | undefined;
    static isDingTalk(): boolean;
    private mOptions;
    private mCanvas?;
    constructor(context: IUniCanvasContext);
    init(options: IUniCanvasContext): void;
    protected createCanvas(): HTMLCanvasElement;
    /**
     * 通过 canvas 来创建 Image 对象。
     */
    private createImage;
    loadImage(options: string | ImageLoadOptions): Promise<HTMLImageElement | DzImage | null>;
    startJob(options: JobStartOptions): JobStartResult | undefined;
    protected onCanvasClear(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void;
    commitJob(): Promise<PageEndResult | undefined>;
}
