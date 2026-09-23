function success(result) {
  return { statusCode: 0, resultInfo: result };
}

function failure(error) {
  return {
    statusCode: Number(error && (error.statusCode || error.errCode)) || -1,
    errMsg: String((error && (error.message || error.errMsg)) || error || 'BLE 操作失败'),
    resultInfo: error,
  };
}

function complete(promise, options, transform) {
  return Promise.resolve(promise).then((value) => {
    const result = transform ? transform(value) : success(value);
    if (options && typeof options.success === 'function') options.success(result);
    if (options && typeof options.complete === 'function') options.complete(result);
    return result;
  }).catch((error) => {
    const result = failure(error);
    if (options && typeof options.fail === 'function') options.fail(result);
    if (options && typeof options.complete === 'function') options.complete(result);
    return result;
  });
}

export default class LpapiSharedAdapter {
  constructor(context) {
    this.transport = context.transport;
    this.manager = context.manager;
    this.owner = context.owner || 'printer';
    this.isH5 = false;
    this.Context = { bleAdapter: this, ownership: 'shared' };
    this.scanId = '';
    this.scanGeneration = 0;
    this.scanDevices = new Map();
    this.scanOperation = Promise.resolve();
    this.connectionCallbacks = new Map();
    this.connectionStateListeners = new Set();
    this.notificationCallbacks = new Map();
    this.unsubscribeConnection = this.manager.dispatcher.on('domainConnectionChanged', (event) => {
      if (!event) return;
      const session = event.deviceId ? this.manager.registry.get(event.deviceId) : null;
      const belongsToOwner = event.owner === this.owner || !!(session && session.owners && session.owners.has(this.owner));
      if (!belongsToOwner) return;
      const callback = this.connectionCallbacks.get(event.deviceId);
      if (typeof callback === 'function') callback(event);
      this.connectionStateListeners.forEach((listener) => listener(event));
      if (event.connected === false) this.connectionCallbacks.delete(event.deviceId);
    });
  }

  get platform() {
    try {
      const info = uni.getSystemInfoSync();
      return info.platform || info.osName || '';
    } catch (_) { return ''; }
  }

  authorize(options) { return complete(this.manager.requestPermissions(), options); }
  openAdapter(options) { return complete(this.manager.openAppBleSession(), options); }
  closeAdapter(options) { return complete(Promise.resolve({ released: true, ownership: 'shared' }), options); }
  resetAdapter(options) { return complete(Promise.resolve({ reset: false, ownership: 'shared' }), options); }

  enqueueScanOperation(action) {
    const result = this.scanOperation.then(action, action);
    this.scanOperation = result.catch(() => undefined);
    return result;
  }

  startDiscovery(options) {
    const opts = options || {};
    return complete(this.enqueueScanOperation(async () => {
      await this.stopDiscoveryInternal();
      const generation = ++this.scanGeneration;
      this.scanDevices.clear();
      const handle = await this.transport.addScanSubscription({
        owner: this.owner,
        allowDuplicatesKey: true,
        interval: opts.interval || 200,
        onDevice: (device) => {
          if (generation !== this.scanGeneration || !device || !device.deviceId) return;
          this.scanDevices.set(device.deviceId, { ...device });
          if (typeof opts.deviceFound === 'function') opts.deviceFound([device]);
        },
      });
      if (generation !== this.scanGeneration) {
        await this.transport.removeScanSubscription(handle.scanId).catch(() => undefined);
        return { ...handle, devices: [], discovering: false, cancelled: true };
      }
      this.scanId = handle.scanId;
      return { ...handle, devices: Array.from(this.scanDevices.values()) };
    }), options);
  }

  stopDiscovery(options) {
    return complete(this.enqueueScanOperation(() => this.stopDiscoveryInternal()), options);
  }

  async stopDiscoveryInternal() {
    this.scanGeneration += 1;
    const scanId = this.scanId;
    this.scanId = '';
    if (scanId) await this.transport.removeScanSubscription(scanId);
    this.scanDevices.clear();
    return { stopped: true, scanId };
  }

  getFoundDevices(options) {
    const devices = Array.from(this.scanDevices.values());
    return complete(Promise.resolve(devices), options, (value) => success(value));
  }

  connect(options) {
    const opts = options || {};
    if (typeof opts.connectionStateChange === 'function') {
      this.connectionCallbacks.set(opts.deviceId, opts.connectionStateChange);
    }
    return complete(this.transport.connect(this.owner, opts.deviceId, {
      deviceType: 'printer',
      timeout: opts.timeout,
    }).catch((error) => {
      this.connectionCallbacks.delete(opts.deviceId);
      throw error;
    }), options);
  }

  disconnect(options) {
    const opts = typeof options === 'string' ? { deviceId: options } : (options || {});
    return complete(this.transport.disconnect(this.owner, opts.deviceId).then((result) => {
      this.connectionCallbacks.delete(opts.deviceId);
      return result;
    }), opts);
  }

  getConnectedDevices(options) {
    const devices = this.manager.registry.active()
      .filter((session) => session.owner === this.owner || !!(session.owners && session.owners.has(this.owner)))
      .map((session) => ({ deviceId: session.deviceId, connected: session.connected }));
    return complete(Promise.resolve(devices), options, (value) => success(value));
  }

  setBleMtu(options) {
    const opts = options || {};
    return this.transport.requestMtu(opts.deviceId, opts.mtu || 512)
      .then((mtu) => ({ status: 0, mtu, waits: opts.waits || 0 }))
      .catch(() => ({ status: opts.required ? 2 : -1, waits: opts.waits || 0 }));
  }

  getGATTServices(options) {
    const opts = options || {};
    return this.transport.getServices(opts.deviceId).then((items) => items.map((item) => ({
      ...item,
      uuid: item.uuid || item.serviceId || '',
    }))).catch((error) => {
      if (typeof opts.fail === 'function') opts.fail(error);
      return [];
    });
  }

  getGATTCharacteristics(options) {
    const opts = options || {};
    return this.transport.getCharacteristics(opts.deviceId, opts.serviceId).then((items) => items.map((item) => ({
      ...item,
      serviceId: opts.serviceId,
      uuid: item.uuid || item.characteristicId || '',
      properties: propertyBits(item.properties),
    }))).catch((error) => {
      if (typeof opts.fail === 'function') opts.fail(error);
      return [];
    });
  }

  read(options) {
    const key = gattKey(options);
    return complete(new Promise((resolve, reject) => {
      let subscriptionId = '';
      const timer = setTimeout(() => {
        if (subscriptionId) this.transport.unsubscribe(subscriptionId).catch(() => undefined);
        reject(new Error('读取特征值超时'));
      }, 1500);
      this.transport.subscribe(key, (data) => {
        clearTimeout(timer);
        this.transport.unsubscribe(subscriptionId).catch(() => undefined);
        resolve(new Uint8Array(data));
      }).then((id) => {
        subscriptionId = id;
        return this.transport.read(key);
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    }), options, (value) => success(value));
  }

  notify(options) {
    const opts = options || {};
    const key = gattKey(opts);
    const registryKey = makeGattKey(key);
    const previousId = this.notificationCallbacks.get(registryKey);
    if (opts.state === false) {
      this.notificationCallbacks.delete(registryKey);
      return complete(previousId ? this.transport.unsubscribe(previousId) : Promise.resolve(), options);
    }
    const replacePrevious = previousId ? this.transport.unsubscribe(previousId) : Promise.resolve();
    return complete(replacePrevious.then(() => this.transport.subscribe(key, (data) => {
      if (typeof opts.dataReceived === 'function') opts.dataReceived(new Uint8Array(data));
    })).then((id) => {
      this.notificationCallbacks.set(registryKey, id);
      return id;
    }), options);
  }

  write(options) {
    const data = options.value || options.data;
    return complete(this.transport.write(gattKey(options), data, options.withResponse), options);
  }

  onBluetoothAdapterStateChange() {}

  onBLEConnectionStateChange(listener) {
    if (typeof listener !== 'function') return () => undefined;
    this.connectionStateListeners.add(listener);
    return () => this.connectionStateListeners.delete(listener);
  }

  onBLECharacteristicValueChange() {}

  async releaseConnection(deviceId) {
    const normalizedDeviceId = String(deviceId || '').toLowerCase();
    const entries = Array.from(this.notificationCallbacks.entries()).filter(([key]) => (
      !normalizedDeviceId || key.indexOf(`${normalizedDeviceId}|`) === 0
    ));
    for (let index = 0; index < entries.length; index += 1) {
      const [key, id] = entries[index];
      this.notificationCallbacks.delete(key);
      await this.transport.unsubscribe(id).catch(() => undefined);
    }
    if (deviceId) this.connectionCallbacks.delete(deviceId);
    else this.connectionCallbacks.clear();
  }

  async release() {
    await this.stopDiscovery().catch(() => undefined);
    await this.releaseConnection();
    this.connectionStateListeners.clear();
    if (this.unsubscribeConnection) this.unsubscribeConnection();
    this.unsubscribeConnection = null;
  }
}

function gattKey(options) {
  return {
    deviceId: options.deviceId,
    serviceId: options.serviceId,
    characteristicId: options.characteristicId,
  };
}

function makeGattKey(key) {
  return [key.deviceId, key.serviceId, key.characteristicId].map((value) => String(value || '').toLowerCase()).join('|');
}

function propertyBits(properties) {
  const source = properties || {};
  let result = 0;
  if (source.read) result |= 2;
  if (source.write) result |= source.writeNoResponse ? 4 : 8;
  if (source.notify) result |= 16;
  if (source.indicate) result |= 32;
  return result;
}