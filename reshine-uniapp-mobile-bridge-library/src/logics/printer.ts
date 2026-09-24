import '@nasl/types';
import { snapdom } from '@zumer/snapdom';
import { assertFinite, assertImage, assertInteger, assertString, invoke, invokeWithImage } from './capability-client';

/**
 * @NaslLogic
 * @type h5
 * @title 连接打印机
 * @param deviceId 设备 ID
 * @param name 设备名称
 * @param timeout 超时毫秒数
 * @returns 连接结果
 */
export async function printer_connect(
  deviceId: nasl.core.String
): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: { printer: { deviceId: nasl.core.String; deviceName: nasl.core.String; name: nasl.core.String } };
}> {
  return invoke('printer_connect', { deviceId: assertString(deviceId, 'deviceId'), name: '', timeout: 12000 }, 65000);
}
/**
 * @NaslLogic
 * @type h5
 * @title 断开打印机
 * @returns 断开结果
 */
export async function printer_disconnect(): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: { disconnected: nasl.core.Boolean; alreadyDisconnected: nasl.core.Boolean; deviceId: nasl.core.String };
}> {
  return invoke('printer_disconnect');
}
/**
 * @NaslLogic
 * @type h5
 * @title 获取打印机状态
 * @returns 打印机状态
 */
export async function printer_status(): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: {
    connected: nasl.core.Boolean;
    busy: nasl.core.Boolean;
    activeJob: nasl.core.String;
    deviceId: nasl.core.String;
    deviceName: nasl.core.String;
  };
}> {
  return invoke('printer_status');
}
/**
 * @NaslLogic
 * @type h5
 * @title 打印图片
 * @param image 图片 Data URL 或 HTTP URL
 * @param width 宽度，默认 80 mm
 * @param height 高度，默认 40 mm
 * @param orientation 方向，允许 0/90/180/270，默认 90 度
 * @param copies 份数
 * @param gapType 纸张类型
 * @param printDarkness 浓度
 * @param printSpeed 速度
 * @param threshold 阈值，默认 180
 * @returns 打印结果
 */
export async function printer_print(
  image: nasl.core.String,
  width?: nasl.core.Decimal,
  height?: nasl.core.Decimal,
  orientation?: nasl.core.Integer,
  copies?: nasl.core.Integer,
  gapType?: nasl.core.Integer,
  printDarkness?: nasl.core.Integer,
  printSpeed?: nasl.core.Integer,
  threshold?: nasl.core.Integer
): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: {} }> {
  return invokeWithImage(
    'printer_print',
    printParams(image, width ?? 80, height ?? 40, orientation ?? 90, threshold ?? 180, { copies, gapType, printDarkness, printSpeed }),
    65000,
    `print-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
/**
 * @NaslLogic
 * @type h5
 * @title 生成打印预览
 * @param image 图片 Data URL 或 HTTP URL
 * @param width 宽度
 * @param height 高度
 * @returns 预览结果
 */
export async function printer_preview(
  image: nasl.core.String,
  width: nasl.core.Decimal,
  height: nasl.core.Decimal
): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { image: nasl.core.String } }> {
  return invokeWithImage('printer_preview', previewParams(image, width, height), 65000);
}
function previewParams(image: unknown, width: unknown, height: unknown) {
  return { image: assertImage(image), width: assertFinite(width, 'width', 0, 1000), height: assertFinite(height, 'height', 0, 5000) } as any;
}
function printParams(image: unknown, width: unknown, height: unknown, orientation: unknown, threshold: unknown, extra: Record<string, unknown> = {}) {
  const result: Record<string, unknown> = {
    image: assertImage(image),
    width: assertFinite(width, 'width', 0, 1000),
    height: assertFinite(height, 'height', 0, 5000),
    orientation: assertInteger(orientation, 'orientation', 0, 270, 90, [0, 90, 180, 270]),
    threshold: assertInteger(threshold, 'threshold', 0, 255, 180),
  };
  if ('copies' in extra)
    Object.assign(result, {
      copies: assertInteger(extra.copies, 'copies', 1, 1000, 1),
      gapType: assertInteger(extra.gapType, 'gapType', 0, 255, 255, [0, 1, 2, 3, 4, 255]),
      printDarkness: assertInteger(extra.printDarkness, 'printDarkness', 1, 255, 255, [...Array(15)].map((_, i) => i + 1).concat(255)),
      printSpeed: assertInteger(extra.printSpeed, 'printSpeed', 1, 255, 255, [1, 2, 3, 4, 5, 255]),
    });
  return result as any;
}

type CaptureData = {
  image: nasl.core.String;
  mimeType: nasl.core.String;
  pixelWidth: nasl.core.Integer;
  pixelHeight: nasl.core.Integer;
  byteLength: nasl.core.Integer;
};
type CapturedImage = { image: string; mimeType: 'image/png'; pixelWidth: number; pixelHeight: number; byteLength: number };
const CAPTURE_BACKGROUND = '#ffffff';
const PREFERRED_CAPTURE_SCALE = 1.5;
const MAX_CAPTURE_SCALE = 4;
const MAX_CAPTURE_PIXELS = 4000000;
const RESOURCE_WAIT_TIMEOUT = 5000;
const CAPTURE_TIMEOUT = 15000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
class PrinterInputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function inputError<T>(error: unknown): { status: string; code: string; message: string; data: T } {
  const err = error as PrinterInputError;
  return { status: 'error', code: err?.code || 'CAPTURE_FAILED', message: String(err?.message || error), data: {} as T };
}
function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1).replace(/\s/g, '');
  return Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0));
}

function findVueRoots(): any[] {
  if (typeof document === 'undefined') return [];
  const roots: any[] = [];
  const seen = new Set<any>();
  const append = (value: any) => {
    if (value && !seen.has(value)) {
      seen.add(value);
      roots.push(value);
    }
  };
  [document.querySelector('#app'), document.body?.firstElementChild, document.documentElement].forEach((node) => append((node as any)?.__vue__));
  document.querySelectorAll('*').forEach((node) => append((node as any).__vue__));
  return roots;
}

function findRefs(vm: any, refName: string, output: any[], visited: Set<any>): void {
  if (!vm || visited.has(vm)) return;
  visited.add(vm);
  const refs = vm.$refs;
  if (refs && Object.prototype.hasOwnProperty.call(refs, refName)) {
    const value = refs[refName];
    Array.isArray(value) ? output.push(...value) : output.push(value);
  }
  const children = Array.isArray(vm.$children) ? vm.$children : [];
  children.forEach((child: any) => findRefs(child, refName, output, visited));
}

function refValueToElement(value: any): Element | null {
  if (typeof Element !== 'undefined' && value instanceof Element) return value;
  if (typeof Element !== 'undefined' && value?.$el instanceof Element) return value.$el;
  return null;
}

function appendElement(matches: Element[], value: any): void {
  if (Array.isArray(value)) {
    value.forEach((item) => appendElement(matches, item));
    return;
  }
  const element = refValueToElement(value);
  if (element && !matches.includes(element)) matches.push(element);
}

function collectVueRefElements(refName: string): Element[] {
  const matches: Element[] = [];
  const visited = new Set<any>();
  for (const root of findVueRoots()) {
    const refs: any[] = [];
    findRefs(root, refName, refs, visited);
    refs.forEach((value) => appendElement(matches, value));
  }
  return matches;
}

function collectDomRefElements(refName: string): Element[] {
  if (typeof document === 'undefined') return [];
  const matches: Element[] = [];
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(refName) : refName.replace(/["\\]/g, '\\$&');
  const selectors = [`[data-ref="${escaped}"]`, `[ref="${escaped}"]`];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      if (!matches.includes(element)) matches.push(element);
    });
  });
  return matches;
}

function resolveRefElement(refName: string): HTMLElement {
  // CodeWave 产物不保证保留 Vue 2 的 __vue__/$refs 私有字段，因此先查组件树，
  // 再回退到编译后仍可见的 ref/data-ref DOM 标记。
  const vueMatches = collectVueRefElements(refName);
  const matches = vueMatches.length ? vueMatches : collectDomRefElements(refName);
  const connected = matches.filter((element) => element.isConnected);
  if (!connected.length) throw new PrinterInputError('REF_NOT_FOUND', `未找到已渲染的 ref：${refName}`);
  const visible = connected.filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
  const candidates = visible.length ? visible : connected;
  if (candidates.length > 1) throw new PrinterInputError('REF_AMBIGUOUS', `ref ${refName} 在当前组件树中对应多个元素`);
  const element = candidates[0];
  if (element.tagName.toLowerCase() === 'template') throw new PrinterInputError('REF_NOT_ELEMENT', `ref ${refName} 指向 template，无法截图`);
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new PrinterInputError('REF_NOT_VISIBLE', `ref ${refName} 对应元素没有可截图尺寸`);
  return element as HTMLElement;
}

function withTimeout<T>(promise: Promise<T>, timeout: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrinterInputError(code, message)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitForImage(image: HTMLImageElement, timeout: number): Promise<void> {
  if (image.complete && image.naturalWidth > 0) {
    if (typeof image.decode === 'function') await image.decode().catch(() => undefined);
    return;
  }
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new PrinterInputError('IMAGE_LOAD_FAILED', `图片加载失败：${image.currentSrc || image.src}`));
      };
      const cleanup = () => {
        image.removeEventListener('load', loaded);
        image.removeEventListener('error', failed);
      };
      image.addEventListener('load', loaded, { once: true });
      image.addEventListener('error', failed, { once: true });
    }),
    timeout,
    'RESOURCE_TIMEOUT',
    '等待图片加载超时'
  );
  if (typeof image.decode === 'function') await image.decode().catch(() => undefined);
}

async function waitForResources(element: Element, timeout: number): Promise<void> {
  const tasks: Promise<unknown>[] = Array.from(element.querySelectorAll('img')).map((image) => waitForImage(image, timeout));
  const fonts = (document as any).fonts?.ready;
  if (fonts && typeof fonts.then === 'function') tasks.push(fonts);
  await withTimeout(
    Promise.all(tasks).then(() => undefined),
    timeout,
    'RESOURCE_TIMEOUT',
    '等待字体或图片加载超时'
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function resolveCaptureScale(rect: { width: number; height: number }): number {
  const maxByPixels = Math.sqrt(MAX_CAPTURE_PIXELS / (rect.width * rect.height));
  return Math.max(1, Math.min(PREFERRED_CAPTURE_SCALE, MAX_CAPTURE_SCALE, maxByPixels));
}

function loadRasterImage(src: string): Promise<HTMLImageElement> {
  return withTimeout(
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new PrinterInputError('CAPTURE_FAILED', '截图解码失败'));
      image.src = src;
    }),
    CAPTURE_TIMEOUT,
    'CAPTURE_TIMEOUT',
    '截图解码超时'
  );
}

async function captureRef(refName: nasl.core.String): Promise<CapturedImage> {
  const name = String(refName || '').trim();
  if (!name) throw new PrinterInputError('INVALID_REF', 'refName 不能为空');
  const element = resolveRefElement(name);
  await waitForResources(element, RESOURCE_WAIT_TIMEOUT);
  const rect = element.getBoundingClientRect();
  const scale = resolveCaptureScale(rect);
  let rendered: any;
  try {
    rendered = await withTimeout(
      snapdom.toPng(element, {
        scale,
        dpr: 1,
        backgroundColor: CAPTURE_BACKGROUND,
        embedFonts: true,
        reconcile: true,
        compress: false,
        cache: 'auto',
      }),
      CAPTURE_TIMEOUT,
      'CAPTURE_TIMEOUT',
      'DOM 转图片超时'
    );
  } catch (error) {
    if (error instanceof PrinterInputError) throw error;
    throw new PrinterInputError('CAPTURE_FAILED', `DOM 转图片失败：${String((error as Error)?.message || error)}`);
  }
  if (!rendered?.src) throw new PrinterInputError('CAPTURE_FAILED', 'snapDOM 未生成有效图片');
  const decoded = await loadRasterImage(rendered.src);
  const pixelWidth = decoded.naturalWidth || decoded.width;
  const pixelHeight = decoded.naturalHeight || decoded.height;
  if (!pixelWidth || !pixelHeight) throw new PrinterInputError('CAPTURE_FAILED', '截图像素尺寸无效');
  const byteLength = estimateDataUrlBytes(rendered.src);
  if (byteLength <= 0) throw new PrinterInputError('CAPTURE_FAILED', '截图数据为空');
  if (byteLength > MAX_IMAGE_BYTES) throw new PrinterInputError('IMAGE_TOO_LARGE', `截图超过 ${MAX_IMAGE_BYTES} 字节限制`);
  return { image: rendered.src, mimeType: 'image/png', pixelWidth, pixelHeight, byteLength };
}

/**
 * @NaslLogic
 * @type h5
 * @title 截取页面引用图片
 * @description 根据已渲染的 Vue ref 截取真实 DOM，等待字体、图片和布局稳定后返回白底 PNG Base64。只负责截图，不涉及打印尺寸、旋转、阈值、蓝牙或插件。
 * @param refName Vue 模板 ref 字符串
 * @returns data 为 { image, mimeType, pixelWidth, pixelHeight, byteLength }
 */
export async function printer_capture(
  refName: nasl.core.String
): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: {
    image: nasl.core.String;
    mimeType: nasl.core.String;
    pixelWidth: nasl.core.Integer;
    pixelHeight: nasl.core.Integer;
    byteLength: nasl.core.Integer;
  };
}> {
  try {
    const result = await captureRef(refName);
    return { status: 'success', code: 'OK', message: '截图成功', data: result };
  } catch (error) {
    return inputError<CaptureData>(error);
  }
}
