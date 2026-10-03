import { ErrorCodes } from '../../errors/codes';
import { createBleError, normalizeError, toPublicError } from '../../errors/normalize';

function waitError(code, message) {
  return createBleError(code, message, { recoverable: true });
}

export default class ScaleService {
  constructor(context) {
    this.transport = context.transport;
    this.dispatcher = context.dispatcher;
    this.profile = context.profile;
    this.state = 'disconnected';
    this.currentDevice = null;
    this.gatt = null;
    this.identityVerified = false;
    this.notificationId = null;
    this.notificationPromise = null;
    this.decoder = this.profile.createDecoder();
    this.discoveryId = null;
    this.discoveryStartToken = 0;
    this.discoveryStopRequested = false;
    this.discoveryTimer = null;
    this.discoveryOperation = Promise.resolve();
    this.waiters = new Set();
    this.readPromise = null;
    this.generation = 0;
    this.lastError = null;
    this.destroyed = false;
    this.unsubscribeConnection = null;
    this.ensureConnectionListener();
  }

  ensureConnectionListener() {
    if (!this.unsubscribeConnection) {
      this.unsubscribeConnection = this.dispatcher.on('domainConnectionChanged', (event) => this.handleConnectionChanged(event));
    }
  }

  emit(name, payload) { this.dispatcher.emit(`scale:${name}`, payload); }

  setState(state, error) {
    this.state = state;
    this.lastError = error ? toPublicError(error) : null;
    this.emit('stateChanged', this.getStateSync());
    if (error) this.emit('error', this.lastError);
  }

  getStateSync() {
    const connected = !!(this.currentDevice && this.transport.isConnected(this.currentDevice.deviceId));
    return {
      state: this.state,
      connected,
      ready: this.state === 'ready' && connected,
      occupied: !!this.currentDevice,
      identityVerified: this.identityVerified,
      device: this.currentDevice ? Object.assign({}, this.currentDevice) : null,
      serviceId: this.gatt ? this.gatt.serviceId : '',
      notifyCharacteristicId: this.gatt ? this.gatt.notifyCharacteristic.uuid : '',
      writeCharacteristicId: this.gatt ? this.gatt.writeCharacteristic.uuid : '',
      lastError: this.lastError,
    };
  }

  getState() { return Promise.resolve(this.getStateSync()); }

  enqueueDiscovery(action) {
    const result = this.discoveryOperation.then(action, action);
    this.discoveryOperation = result.catch(() => undefined);
    return result;
  }

  startDiscovery(options) {
    this.discoveryStopRequested = false;
    return this.enqueueDiscovery(() => this.startDiscoveryInternal(options));
  }

  async startDiscoveryInternal(options) {
    this.destroyed = false;
    this.ensureConnectionListener();
    await this.stopDiscoveryInternal();
    this.discoveryStopRequested = false;
    const source = options || {};
    const timeout = Number(source.timeout) > 0 ? Number(source.timeout) : 15000;
    const startToken = ++this.discoveryStartToken;
    this.discoveryStopRequested = false;
    const handle = await this.transport.addScanSubscription({
      owner: 'scale',
      allowDuplicatesKey: false,
      interval: 0,
      matcher: (device) => this.profile.matches(device),
      onDevice: (device, scanId) => {
        if (!device) return;
        this.emit('deviceFound', this.toScaleDevice(device, scanId));
      },
    });
    if (this.destroyed || startToken !== this.discoveryStartToken || this.discoveryStopRequested) {
      await this.transport.removeScanSubscription(handle.scanId).catch(() => undefined);
      return Object.assign({}, handle, { devices: [], discovering: false, cancelled: true });
    }
    this.discoveryId = handle.scanId;
    this.discoveryTimer = setTimeout(async () => {
      await this.transport.removeScanSubscription(handle.scanId).catch(() => undefined);
      this.finishDiscovery(handle.scanId, 'timeout');
    }, timeout);
    this.emit('discoveryStateChanged', { discovering: true, scanId: handle.scanId, reason: 'started' });
    return Object.assign({}, handle, {
      devices: handle.devices
        .filter((item) => this.profile.matches(item))
        .map((item) => this.toScaleDevice(item, handle.scanId)),
    });
  }

  stopDiscovery() {
    this.discoveryStopRequested = true;
    this.discoveryStartToken += 1;
    return this.enqueueDiscovery(() => this.stopDiscoveryInternal());
  }

  async stopDiscoveryInternal() {
    const scanId = this.discoveryId;
    if (!scanId) return;
    await this.transport.removeScanSubscription(scanId).catch(() => undefined);
    this.finishDiscovery(scanId, 'stopped');
  }

  finishDiscovery(scanId, reason) {
    if (scanId !== this.discoveryId) return;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryId = null;
    this.discoveryTimer = null;
    this.emit('discoveryStateChanged', { discovering: false, scanId, reason });
  }

  toScaleDevice(device, scanId) {
    return Object.assign({}, device, {
      scanId,
      deviceType: 'scale',
      profileId: this.profile.id,
      identityVerified: false,
      identityReasons: this.profile.identityReasons(device),
    });
  }

  async connect(deviceId) {
    this.destroyed = false;
    this.ensureConnectionListener();
    if (!deviceId || typeof deviceId !== 'string') throw createBleError(ErrorCodes.INVALID_ARGUMENT, '缺少电子秤 deviceId');
    if (this.state === 'ready' && this.currentDevice && this.currentDevice.deviceId === deviceId) return this.getStateSync();
    if (this.currentDevice && this.currentDevice.deviceId !== deviceId) {
      throw createBleError(ErrorCodes.SCALE_ALREADY_CONNECTED, '已有活动电子秤，请先断开再连接其他设备');
    }
    this.generation += 1;
    const generation = this.generation;
    const discovered = this.transport.getFoundDevices({ deviceId })[0];
    this.currentDevice = Object.assign({}, discovered || {}, {
      deviceId,
      deviceType: 'scale',
      profileId: this.profile.id,
      identityVerified: false,
      identityReasons: discovered ? this.profile.identityReasons(discovered) : [],
    });
    this.identityVerified = false;
    try {
      this.invalidateWeight(ErrorCodes.SCALE_NOT_READY, '电子秤正在连接');
      this.setState('connecting');
      await this.transport.connect('scale', deviceId, { deviceType: 'scale', timeout: 12000 });
      if (generation !== this.generation) {
        await this.transport.disconnect('scale', deviceId).catch(() => undefined);
        throw createBleError(ErrorCodes.SCALE_NOT_READY, '电子秤连接已取消');
      }
    await this.initializeGatt(generation);
      if (generation !== this.generation || this.state !== 'ready') {
        throw createBleError(ErrorCodes.SCALE_NOT_READY, '电子秤连接已取消');
      }
      this.lastError = null;
      return this.getStateSync();
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.CONNECT_FAILED);
      if (generation === this.generation) {
        await this.cleanupGatt(true);
        this.setState('failed', normalized);
      }
      throw normalized;
    }
  }

  async initializeGatt(generation) {
    this.setState('discovering');
    const services = await this.transport.getServices(this.currentDevice.deviceId);
    const characteristicsByService = {};
    for (let index = 0; index < services.length; index += 1) {
      const serviceId = services[index].uuid;
      characteristicsByService[serviceId] = await this.transport.getCharacteristics(this.currentDevice.deviceId, serviceId);
    }
    if (generation !== this.generation) return;
    const gatt = this.profile.selectGatt(services, characteristicsByService);
    const notifyCandidates = [];
    const readCandidates = [];
    Object.keys(characteristicsByService).forEach((serviceId) => {
      characteristicsByService[serviceId].forEach((item) => {
        const properties = item.properties || {};
        const candidate = {
          serviceId,
          characteristicId: item.uuid,
          properties: sanitizeProperties(properties),
        };
        if (properties.notify || properties.indicate) notifyCandidates.push(candidate);
        if (properties.read) readCandidates.push(candidate);
      });
    });
    this.emit('gattDiscovered', {
      deviceId: this.currentDevice.deviceId,
      advertisement: sanitizeAdvertisement(this.currentDevice),
      services: services.map((service) => ({ uuid: service.uuid, isPrimary: service.isPrimary })),
      characteristics: Object.keys(characteristicsByService).reduce((result, serviceId) => {
        result[serviceId] = characteristicsByService[serviceId].map((item) => ({
          uuid: item.uuid,
          properties: sanitizeProperties(item.properties),
        }));
        return result;
      }, {}),
      notifyCandidates,
      readCandidates,
      selected: gatt ? {
        strategy: 'verified-gatt-profile',
        serviceId: gatt.serviceId,
        notifyCharacteristicId: gatt.notifyCharacteristic.uuid,
        writeCharacteristicId: gatt.writeCharacteristic.uuid,
        properties: sanitizeProperties(gatt.notifyCharacteristic.properties),
        writeProperties: sanitizeProperties(gatt.writeCharacteristic.properties),
      } : null,
    });
    if (!gatt) throw createBleError(ErrorCodes.SCALE_WEIGHT_CHARACTERISTIC_NOT_FOUND, '设备不匹配已验证的电子秤 GATT 指纹');
    this.gatt = gatt;
    this.identityVerified = true;
    this.currentDevice = Object.assign({}, this.currentDevice, { identityVerified: true });
    this.decoder.reset();
    await this.ensureWeightNotifications({ initialization: true, generation });
    if (generation !== this.generation || !this.gatt || !this.transport.isConnected(this.currentDevice.deviceId)) return;
    this.setState('ready');
  }

  async disconnect() {
    const deviceId = this.currentDevice && this.currentDevice.deviceId;
    if (!deviceId) {
      this.invalidateWeight(ErrorCodes.SCALE_NOT_CONNECTED, '电子秤未连接');
      this.gatt = null;
      this.identityVerified = false;
      this.lastError = null;
      if (this.state !== 'disconnected') this.setState('disconnected');
      return { disconnected: true };
    }
    this.generation += 1;
    this.setState('disconnecting');
    this.invalidateWeight(ErrorCodes.SCALE_NOT_CONNECTED, '电子秤已断开');
    await this.cleanupGatt(true);
    this.currentDevice = null;
    this.gatt = null;
    this.identityVerified = false;
    this.lastError = null;
    this.setState('disconnected');
    return { disconnected: true, deviceId };
  }

  async cleanupGatt(disconnectPhysical) {
    const deviceId = this.currentDevice && this.currentDevice.deviceId;
    await this.stopWeightNotifications();
    this.decoder.reset();
    this.gatt = null;
    this.identityVerified = false;
    if (disconnectPhysical && deviceId) await this.transport.disconnect('scale', deviceId).catch(() => undefined);
  }

  handleNotification(data, event, generation) {
    if (generation !== this.generation || this.state === 'disconnected') return;
    const rawPayload = {
      deviceId: event && event.deviceId,
      serviceId: event && event.serviceId,
      characteristicId: event && event.characteristicId,
      hex: bufferToHex(data),
      compactHex: bufferToCompactHex(data),
      decimalBytes: bufferToDecimal(data),
      ascii: bufferToAscii(data),
      byteLength: data ? data.byteLength : 0,
      receivedAt: Date.now(),
    };
    this.emit('rawFrame', rawPayload);
    try {
      const readings = this.decoder.push(data);
      readings.forEach((reading) => this.acceptReading(reading, event));
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.SCALE_FRAME_INVALID);
      this.emit('rawFrame', Object.assign({}, rawPayload, { error: toPublicError(normalized) }));
      this.emit('error', toPublicError(normalized));
      Array.from(this.waiters).forEach((waiter) => this.finishWaiter(waiter, normalized));
    }
  }

  acceptReading(reading, event) {
    const next = Object.freeze(Object.assign({}, reading, {
      sequence: this.latestReading ? this.latestReading.sequence + 1 : 1,
      deviceId: this.currentDevice.deviceId,
      serviceId: event && event.serviceId,
      characteristicId: event && event.characteristicId,
    }));
    this.latestReading = next;
    Array.from(this.waiters).forEach((waiter) => {
      if (next.sequence > waiter.afterSequence) this.tryResolveWaiter(waiter, next);
    });
  }

  readWeight(timeout) {
    if (this.readPromise) return this.readPromise;
    const promise = this.performReadWeight(timeout);
    let tracked;
    tracked = promise.finally(() => {
      if (this.readPromise === tracked) this.readPromise = null;
    });
    this.readPromise = tracked;
    return tracked;
  }

  async performReadWeight(timeout) {
    this.assertReady();
    const timeoutMs = Number(timeout) > 0 ? Number(timeout) : 5000;
    this.emit('probeLog', {
      phase: 'weight-read-started',
      deviceId: this.currentDevice.deviceId,
      timeoutMs,
      serviceId: this.gatt.serviceId,
      notifyCharacteristicId: this.gatt.notifyCharacteristic.uuid,
      writeCharacteristicId: this.gatt.writeCharacteristic.uuid,
      writeType: this.gatt.writeCharacteristic.properties && this.gatt.writeCharacteristic.properties.write
        ? 'write'
        : 'writeNoResponse',
      command: 'R',
    });
    await this.ensureWeightNotifications();
    const response = this.waitForReading(timeoutMs, this.latestReading ? this.latestReading.sequence : 0);
    const writeProperties = this.gatt.writeCharacteristic.properties || {};
    const withResponse = !!writeProperties.write;
    try {
      await this.transport.write({
        deviceId: this.currentDevice.deviceId,
        serviceId: this.gatt.serviceId,
        characteristicId: this.gatt.writeCharacteristic.uuid,
      }, asciiBuffer('R'), withResponse);
      const reading = await response;
      if (reading.overloaded) {
        throw createBleError(ErrorCodes.SCALE_OVERLOAD, '电子秤当前超载', {
          recoverable: true,
          reading: Object.assign({}, reading),
        });
      }
      this.emit('probeLog', { phase: 'weight-read-completed', source: 'request-response', reading: Object.assign({}, reading) });
      return reading;
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.SCALE_WEIGHT_READ_FAILED);
      // `response` 在写入失败时仍可能等待超时；先让 waiter 结算，再等待它被消费，避免未处理拒绝。
      Array.from(this.waiters).forEach((waiter) => this.finishWaiter(waiter, normalized));
      await response.catch(() => undefined);
      this.emit('probeLog', {
        phase: 'weight-read-failed',
        error: toPublicError(normalized),
      });
      throw normalized;
    }
  }

  waitForReading(timeout, afterSequence) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, afterSequence: Number(afterSequence) || 0 };
      waiter.timer = setTimeout(() => this.finishWaiter(waiter, waitError(ErrorCodes.SCALE_WEIGHT_READ_FAILED, '等待电子秤返回重量超时')), timeout);
      this.waiters.add(waiter);
    });
  }

  tryResolveWaiter(waiter, reading) {
    if (this.isReadableReading(reading)) this.finishWaiter(waiter, undefined, Object.assign({}, reading));
  }

  isReadableReading(reading) {
    if (!reading || !['stable', 'unstable', 'overload'].includes(reading.status)) return false;
    if (reading.overloaded) return true;
    return reading.valid !== false && ['kg', 'g', 'lb', 'oz'].includes(reading.unit);
  }

  finishWaiter(waiter, error, value) {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error); else waiter.resolve(value);
  }

  invalidateWeight(code, message) {
    this.latestReading = null;
    const error = createBleError(code, message);
    Array.from(this.waiters).forEach((waiter) => this.finishWaiter(waiter, error));
  }

  async ensureWeightNotifications(options) {
    const source = options || {};
    if (source.initialization) {
      const initializationValid = (
        source.generation === this.generation &&
        this.state === 'discovering' &&
        !!this.currentDevice &&
        !!this.gatt &&
        this.transport.isConnected(this.currentDevice.deviceId)
      );
      if (!initializationValid) throw createBleError(ErrorCodes.SCALE_NOT_READY, '电子秤连接初始化已失效');
    } else {
      this.assertReady();
    }
    if (this.notificationId) return this.notificationId;
    if (this.notificationPromise) return this.notificationPromise;
    const generation = this.generation;
    const key = this.notificationKey();
    this.emit('probeLog', { phase: 'notification-subscribe-started', ...key });
    this.notificationPromise = this.transport.subscribe(
      key,
      (data, event) => this.handleNotification(data, event, generation),
    ).then((id) => {
      if (generation !== this.generation || !this.gatt) {
        return this.transport.unsubscribe(id).then(() => null);
      }
      this.notificationId = id;
      this.emit('probeLog', { phase: 'notification-subscribed', subscriptionId: id, ...key });
      return id;
    }).catch((error) => {
      this.emit('probeLog', {
        phase: 'notification-subscribe-failed',
        ...key,
        error: toPublicError(normalizeError(error, ErrorCodes.NOTIFY_FAILED)),
      });
      throw error;
    }).finally(() => {
      this.notificationPromise = null;
    });
    return this.notificationPromise;
  }

  async stopWeightNotifications() {
    const pending = this.notificationPromise;
    if (pending) await pending.catch(() => undefined);
    const notificationId = this.notificationId;
    this.notificationId = null;
    if (notificationId) await this.transport.unsubscribe(notificationId).catch(() => undefined);
    this.decoder.reset();
  }

  assertReady() {
    if (!this.currentDevice) throw createBleError(ErrorCodes.SCALE_NOT_CONNECTED, '电子秤未连接');
    if (this.state !== 'ready' || !this.transport.isConnected(this.currentDevice.deviceId)) throw createBleError(ErrorCodes.SCALE_NOT_READY, '电子秤尚未就绪');
  }

  notificationKey() {
    return { deviceId: this.currentDevice.deviceId, serviceId: this.gatt.serviceId, characteristicId: this.gatt.notifyCharacteristic.uuid };
  }

  handleConnectionChanged(event) {
    if (!this.currentDevice || !event || event.deviceId !== this.currentDevice.deviceId || event.connected !== false) return;
    this.generation += 1;
    this.invalidateWeight(ErrorCodes.UNEXPECTED_DISCONNECT, '电子秤连接异常断开');
    this.notificationId = null;
    this.notificationPromise = null;
    this.decoder.reset();
    this.gatt = null;
    this.identityVerified = false;
    this.currentDevice = null;
    this.setState('disconnected', createBleError(ErrorCodes.UNEXPECTED_DISCONNECT, '电子秤连接异常断开'));
  }

  async destroy() {
    this.destroyed = true;
    await this.stopDiscovery();
    await this.disconnect();
    if (this.unsubscribeConnection) this.unsubscribeConnection();
    this.unsubscribeConnection = null;
  }
}

function asciiBuffer(text) {
  const bytes = new Uint8Array(String(text || '').length);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes.buffer;
}
function bufferToHex(buffer) { return Array.from(new Uint8Array(buffer || new ArrayBuffer(0))).map((value) => value.toString(16).padStart(2, '0')).join(' '); }
function bufferToCompactHex(buffer) { return Array.from(new Uint8Array(buffer || new ArrayBuffer(0))).map((value) => value.toString(16).padStart(2, '0')).join(''); }
function bufferToDecimal(buffer) { return Array.from(new Uint8Array(buffer || new ArrayBuffer(0))); }
function bufferToAscii(buffer) { return Array.from(new Uint8Array(buffer || new ArrayBuffer(0))).map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : '.')).join(''); }
function sanitizeProperties(properties) {
  const source = properties || {};
  return {
    read: !!source.read,
    write: !!source.write,
    writeNoResponse: !!source.writeNoResponse,
    notify: !!source.notify,
    indicate: !!source.indicate,
  };
}
function sanitizeAdvertisement(device) {
  return {
    deviceId: device && device.deviceId,
    name: device && device.name,
    localName: device && device.localName,
    RSSI: device && device.RSSI,
    advertisServiceUUIDs: (device && device.advertisServiceUUIDs) || [],
    advertisDataHex: bufferToHex(device && device.advertisData),
    advertisDataCompactHex: bufferToCompactHex(device && device.advertisData),
    serviceData: (device && device.serviceData) || undefined,
    manufacturerData: (device && device.manufacturerData) || undefined,
  };
}
