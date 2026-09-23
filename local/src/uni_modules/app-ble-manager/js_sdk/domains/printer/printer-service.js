import { LPAPIFactory } from '../../../../dothan-lpapi-ble/js_sdk/index.js';
import { ErrorCodes } from '../../errors/codes';
import { createBleError, normalizeError, toPublicError } from '../../errors/normalize';
import LpapiSharedAdapter from './lpapi-shared-adapter';

const DEFAULT_PRINT_OPTIONS = Object.freeze({
  width: 80,
  height: 40,
  orientation: 90,
  copies: 1,
  gapType: 255,
  darkness: 255,
  speed: 255,
  threshold: 128,
});

export default class PrinterService {
  constructor(context) {
    this.transport = context.transport;
    this.manager = context.manager;
    this.dispatcher = context.dispatcher;
    this.adapter = new LpapiSharedAdapter({ manager: this.manager, transport: this.transport, owner: 'printer' });
    this.api = null;
    this.canvasId = '';
    this.currentPrinter = null;
    this.state = 'disconnected';
    this.lastError = null;
    this.discoveryId = '';
    this.discoveryTimer = null;
    this.discoveryGeneration = 0;
    this.discoveryOperation = Promise.resolve();
    this.operationPromise = null;
    this.connectionGeneration = 0;
    this.unsubscribeConnection = this.dispatcher.on('domainConnectionChanged', (event) => this.handleConnectionChanged(event));
  }

  emit(name, payload) { this.dispatcher.emit(`printer:${name}`, payload); }

  setState(state, error) {
    this.state = state;
    this.lastError = error ? toPublicError(error) : null;
    this.emit('stateChanged', this.getStateSync());
    if (error) this.emit('error', this.lastError);
  }

  getStateSync() {
    const connected = !!(this.currentPrinter && this.transport.isConnected(this.currentPrinter.deviceId));
    return {
      state: this.state,
      connected,
      ready: connected && this.state === 'ready' && !this.operationPromise,
      printer: this.currentPrinter ? { ...this.currentPrinter } : null,
      printing: this.state === 'printing',
      operation: this.state === 'printing' ? 'printing' : 'idle',
      lastError: this.lastError,
    };
  }

  getState() { return Promise.resolve(this.getStateSync()); }

  ensureApi(canvasId) {
    if (canvasId && canvasId !== this.canvasId) this.canvasId = canvasId;
    if (!this.api) {
      try {
        this.api = LPAPIFactory.getInstance({
          canvasId: this.canvasId || undefined,
          showLog: 0,
          ownership: 'shared',
          adapter: this.adapter,
        });
      } catch (error) {
        throw normalizeError(error, ErrorCodes.PRINTER_PLUGIN_UNAVAILABLE);
      }
    } else if (canvasId) {
      LPAPIFactory.getInstance({ canvasId, ownership: 'shared', adapter: this.adapter, showLog: 0 });
    }
    return this.api;
  }

  enqueueDiscovery(action) {
    const result = this.discoveryOperation.then(action, action);
    this.discoveryOperation = result.catch(() => undefined);
    return result;
  }

  startDiscovery(options) {
    return this.enqueueDiscovery(() => this.startDiscoveryInternal(options));
  }

  async startDiscoveryInternal(options) {
    await this.stopDiscoveryInternal();
    const generation = ++this.discoveryGeneration;
    const opts = options || {};
    const api = this.ensureApi(opts.canvasId);
    const result = await api.startBleDiscovery({
      deviceFound: (devices) => {
        if (generation !== this.discoveryGeneration) return;
        (Array.isArray(devices) ? devices : [devices]).forEach((device) => {
          if (!device || !device.deviceId) return;
          this.emit('deviceFound', this.toPrinterDevice(device, this.adapter.scanId));
        });
      },
    });
    this.assertLpapiSuccess(result, '打印机搜索启动失败');
    if (generation !== this.discoveryGeneration) {
      await api.stopBleDiscovery().catch(() => undefined);
      return { scanId: '', discovering: false, devices: [], cancelled: true };
    }
    this.discoveryId = this.adapter.scanId;
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 15000;
    this.discoveryTimer = setTimeout(() => this.stopDiscovery(this.discoveryId).catch(() => undefined), timeout);
    this.emit('discoveryStateChanged', { discovering: true, scanId: this.discoveryId, reason: 'started' });
    return {
      scanId: this.discoveryId,
      discovering: true,
      devices: (result && result.resultInfo && result.resultInfo.devices || [])
        .map((device) => this.toPrinterDevice(device, this.discoveryId)),
    };
  }

  stopDiscovery(scanId) {
    return this.enqueueDiscovery(() => this.stopDiscoveryInternal(scanId));
  }

  async stopDiscoveryInternal(scanId) {
    const target = scanId || this.discoveryId || this.adapter.scanId;
    if (!target) return;
    this.discoveryGeneration += 1;
    if (!this.api || typeof this.api.stopBleDiscovery !== 'function') {
      throw createBleError(ErrorCodes.PRINTER_PLUGIN_UNAVAILABLE, 'LPAPI 插件不支持停止打印机搜索');
    }
    const result = await this.api.stopBleDiscovery();
    this.assertLpapiSuccess(result, '停止打印机搜索失败');
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    if (target === this.discoveryId || !this.discoveryId) this.discoveryId = '';
    this.emit('discoveryStateChanged', { discovering: false, scanId: target, reason: 'stopped' });
  }

  toPrinterDevice(device, scanId) {
    return { ...device, scanId, deviceType: 'printer' };
  }

  async connect(options) {
    const opts = options || {};
    const deviceId = opts.deviceId;
    if (!deviceId) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '缺少打印机 deviceId');
    if (this.currentPrinter && this.currentPrinter.deviceId !== deviceId) {
      throw createBleError(ErrorCodes.PRINTER_ALREADY_CONNECTED, '已有活动打印机，请先断开再连接其他打印机');
    }
    if (this.currentPrinter && this.currentPrinter.deviceId === deviceId && this.getStateSync().ready) return this.getStateSync();
    if (this.currentPrinter && this.currentPrinter.deviceId === deviceId) await this.disconnect();
    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;
    this.currentPrinter = { deviceId, name: opts.name || '', deviceType: 'printer' };
    this.setState('connecting');
    try {
      const api = this.ensureApi(opts.canvasId);
      const result = await api.openPrinter({
        name: opts.name,
        deviceId,
        timeout: opts.timeout || 12000,
        connectionStateChange: (event) => {
          if (event && event.connected === false) this.handleConnectionChanged(event);
        },
      });
      this.assertLpapiSuccess(result, '打印机连接失败', ErrorCodes.CONNECT_FAILED);
      if (generation !== this.connectionGeneration || !api.isPrinterOpened()) throw createBleError(ErrorCodes.PRINTER_NOT_READY, '打印机初始化未完成');
      const info = api.getPrinterInfo() || {};
      this.currentPrinter = { ...this.currentPrinter, ...info, deviceId };
      this.lastError = null;
      this.setState('ready');
      return this.getStateSync();
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.CONNECT_FAILED);
      if (this.api && typeof this.api.closePrinter === 'function') {
        await this.api.closePrinter({ deviceId, force: true }).catch(() => undefined);
      }
      await this.adapter.releaseConnection(deviceId).catch(() => undefined);
      if (this.transport.isConnected(deviceId)) {
        await this.transport.disconnect('printer', deviceId).catch(() => undefined);
      }
      if (generation === this.connectionGeneration) this.setState('failed', normalized);
      throw normalized;
    }
  }

  async disconnect() {
    const printer = this.currentPrinter;
    if (!printer) {
      if (this.state !== 'disconnected') this.setState('disconnected');
      return { disconnected: true };
    }
    this.connectionGeneration += 1;
    this.setState('disconnecting');
    await settle(this.operationPromise);
    try {
      if (!this.api || typeof this.api.closePrinter !== 'function') {
        throw createBleError(ErrorCodes.PRINTER_PLUGIN_UNAVAILABLE, 'LPAPI 插件不支持断开打印机');
      }
      const result = await this.api.closePrinter({ deviceId: printer.deviceId, force: true });
      this.assertLpapiSuccess(result, '断开打印机失败', ErrorCodes.DISCONNECT_FAILED);
    } finally {
      await this.adapter.releaseConnection(printer.deviceId);
      if (this.transport.isConnected(printer.deviceId)) {
        await this.transport.disconnect('printer', printer.deviceId).catch(() => undefined);
      }
      this.currentPrinter = null;
      this.lastError = null;
      this.setState('disconnected');
    }
    return { disconnected: true, deviceId: printer.deviceId };
  }

  preview(job) {
    return this.startImageOperation(job, true);
  }

  print(job) {
    return this.startImageOperation(job, false);
  }

  startImageOperation(job, preview) {
    if (this.operationPromise) {
      return Promise.reject(createBleError(ErrorCodes.PRINTER_PRINTING, '打印机任务正在执行'));
    }
    const promise = this.performImageJob(job, preview);
    this.operationPromise = promise.finally(() => {
      this.operationPromise = null;
      if (!preview && this.currentPrinter && this.state !== 'disconnected' && this.state !== 'disconnecting') {
        this.setState('ready');
      }
    });
    return this.operationPromise;
  }

  async performImageJob(job, preview) {
    const options = normalizePrintOptions(job);
    const api = this.ensureApi(options.canvasId);
    if (!preview && (!this.getStateSync().ready || !api.isPrinterOpened())) {
      throw createBleError(ErrorCodes.PRINTER_NOT_READY, '打印机尚未就绪');
    }
    if (!preview) this.setState('printing');
    try {
      const image = await api.loadImage(options.image);
      if (!image) throw createBleError(ErrorCodes.PRINTER_PRINT_FAILED, '图片加载失败');
      const jobInfo = api.startJob({
        width: options.width,
        height: options.height,
        orientation: options.orientation,
        jobName: preview ? '#!#preview#!#' : options.jobName,
        resetJob: true,
        autoAbort: true,
      });
      if (!jobInfo) throw createBleError(ErrorCodes.PRINTER_PRINT_FAILED, '打印任务创建失败');
      if (typeof options.onCanvasResize === 'function') await options.onCanvasResize(jobInfo.canvas);
      else await waitForCanvasLayout();
      if (!api.startPage()) throw createBleError(ErrorCodes.PRINTER_PRINT_FAILED, '打印页面创建失败');
      const drawn = await api.drawImage({
        image,
        x: 0,
        y: 0,
        width: options.width,
        height: options.height,
        horizontalAlignment: 3,
        verticalAlignment: 3,
      });
      if (drawn === false) throw createBleError(ErrorCodes.PRINTER_PRINT_FAILED, '图片绘制失败');
      let previewResult = null;
      const result = await api.commitJob({
        copies: options.copies,
        gapType: options.gapType,
        darkness: options.darkness,
        speed: options.speed,
        threshold: options.threshold,
        onPageComplete: (event) => {
          previewResult = event;
        },
      });
      this.assertLpapiSuccess(result, preview ? '打印预览生成失败' : '打印任务失败');
      if (preview) {
        return {
          dataUrl: extractPreviewUrl(previewResult) || extractPreviewUrl(result),
          result,
        };
      }
      return {
        submitted: true,
        result,
        printer: this.currentPrinter,
      };
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.PRINTER_PRINT_FAILED);
      if (!preview) {
        if (!this.getStateSync().connected) this.setState('disconnected', normalized);
        else this.lastError = toPublicError(normalized);
      }
      throw normalized;
    }
  }

  assertLpapiSuccess(result, message, fallbackCode) {
    if (result && result.statusCode !== undefined && Number(result.statusCode) !== 0) {
      throw createBleError(fallbackCode || ErrorCodes.PRINTER_PRINT_FAILED, result.errMsg || result.message || message, { cause: result });
    }
  }

  handleConnectionChanged(event) {
    if (!this.currentPrinter || !event || event.deviceId !== this.currentPrinter.deviceId || event.connected !== false) return;
    const unexpected = this.state !== 'disconnecting';
    const disconnectedDeviceId = this.currentPrinter.deviceId;
    this.connectionGeneration += 1;
    this.currentPrinter = null;
    this.adapter.releaseConnection(disconnectedDeviceId).catch(() => undefined);
    this.setState('disconnected', unexpected ? createBleError(ErrorCodes.UNEXPECTED_DISCONNECT, '打印机连接异常断开') : undefined);
  }

  async destroy() {
    await this.stopDiscovery();
    await this.disconnect();
    if (this.unsubscribeConnection) this.unsubscribeConnection();
    this.unsubscribeConnection = null;
  }
}

function normalizePrintOptions(job) {
  const value = { ...DEFAULT_PRINT_OPTIONS, ...(job || {}) };
  value.image = String(value.image || '').trim();
  value.width = Number(value.width);
  value.height = Number(value.height);
  value.orientation = Number(value.orientation);
  value.copies = Number(value.copies);
  value.gapType = Number(value.gapType);
  value.darkness = Number(value.darkness);
  value.speed = Number(value.speed);
  value.threshold = Number(value.threshold);
  value.jobName = value.jobName || 'image-print';
  if (!value.image) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '缺少待打印图片');
  if (!(value.width > 0) || !(value.height > 0)) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '标签宽高必须大于 0');
  if (!Number.isInteger(value.copies) || value.copies < 1 || value.copies > 1000) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '打印份数必须是 1 到 1000 的整数');
  if (!Number.isInteger(value.darkness) || !((value.darkness >= 1 && value.darkness <= 15) || value.darkness === 255)) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '打印浓度必须是 1 到 15 或 255');
  if (!Number.isInteger(value.speed) || !((value.speed >= 1 && value.speed <= 5) || value.speed === 255)) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '打印速度必须是 1 到 5 或 255');
  if (!Number.isInteger(value.threshold) || value.threshold < 0 || value.threshold > 255) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '二值化阈值必须是 0 到 255 的整数');
  return value;
}

function settle(promise) {
  if (!promise) return Promise.resolve();
  return promise.then(() => undefined, () => undefined);
}

function waitForCanvasLayout() {
  return new Promise((resolve) => setTimeout(resolve, 120));
}

function extractPreviewUrl(value) {
  if (!value || typeof value !== 'object') return '';
  const candidates = [value.dataUrl, value.tempFilePath];
  if (Array.isArray(value.previewData)) candidates.push(...value.previewData);
  if (Array.isArray(value.pages)) {
    value.pages.forEach((page) => {
      if (page) candidates.push(page.dataUrl, page.tempFilePath);
    });
  }
  return candidates.find((item) => typeof item === 'string' && item) || '';
}
