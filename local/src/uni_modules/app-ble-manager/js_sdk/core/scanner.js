function normalizeUuid(value) {
  return String(value || '').toLowerCase();
}

function normalizeDevice(device) {
  return Object.assign({}, device, {
    deviceId: device.deviceId || '',
    name: device.name || device.localName || '',
    localName: device.localName || device.name || '',
    RSSI: typeof device.RSSI === 'number' ? device.RSSI : undefined,
    advertisServiceUUIDs: device.advertisServiceUUIDs || [],
    lastSeenAt: Date.now(),
  });
}

function matches(device, options) {
  const name = device.name || device.localName || '';
  if (options.nameContains && name.toLowerCase().indexOf(String(options.nameContains).toLowerCase()) < 0) return false;
  if (options.namePattern) {
    try {
      const pattern = options.namePattern instanceof RegExp ? options.namePattern : new RegExp(options.namePattern, 'i');
      if (!pattern.test(name)) return false;
    } catch (_) { return false; }
  }
  if (typeof options.minRssi === 'number' && (typeof device.RSSI !== 'number' || device.RSSI < options.minRssi)) return false;
  if (options.deviceId && options.deviceId !== device.deviceId) return false;
  if (options.serviceUUIDs && options.serviceUUIDs.length) {
    const advertised = (device.advertisServiceUUIDs || []).map(normalizeUuid);
    if (!options.serviceUUIDs.some((uuid) => advertised.indexOf(normalizeUuid(uuid)) >= 0)) return false;
  }
  return typeof options.matcher !== 'function' || options.matcher(device);
}

export default class Scanner {
  constructor(platform, dispatcher, onStateChange) {
    this.platform = platform;
    this.dispatcher = dispatcher;
    this.onStateChange = onStateChange;
    this.subscriptions = new Map();
    this.devices = new Map();
    this.discovering = false;
    this.sequence = 0;
    this.generation = 0;
    this.operationQueue = Promise.resolve();
    this.unsubscribeDevice = null;
  }

  serialize(task) {
    const result = this.operationQueue.then(task, task);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  start(options) {
    return this.serialize(() => this.startInternal(options));
  }

  async startInternal(options) {
    const source = options || {};
    const generation = this.generation;
    const id = `scan-${Date.now()}-${++this.sequence}`;
    const subscription = { id, options: source, timer: null, cancelled: false };
    this.subscriptions.set(id, subscription);
    if (!this.unsubscribeDevice) this.unsubscribeDevice = this.dispatcher.on('deviceFound', (event) => this.handleFound(event));
    this.emitState('starting', id);
    try {
      if (!this.discovering) {
        await this.platform.startDiscovery({
          allowDuplicatesKey: source.allowDuplicatesKey === true,
          interval: source.interval || 0,
        });
        if (generation !== this.generation) {
          await this.platform.stopDiscovery().catch(() => undefined);
          this.subscriptions.delete(id);
          return { scanId: id, devices: this.getDevices(source), discovering: false, cancelled: true };
        }
        this.discovering = true;
      }
      if (subscription.cancelled || !this.subscriptions.has(id)) {
        if (!this.subscriptions.size && this.discovering) await this.stopPhysicalDiscovery();
        return { scanId: id, devices: this.getDevices(source), discovering: this.discovering, cancelled: true };
      }
      this.emitState('scanning', id);
    } catch (error) {
      this.subscriptions.delete(id);
      this.emitState(this.discovering ? 'scanning' : 'idle', id);
      throw error;
    }
    if (source.timeout > 0) subscription.timer = setTimeout(() => this.stop(id).catch(() => undefined), source.timeout);
    return { scanId: id, devices: this.getDevices(source), discovering: this.discovering };
  }

  stop(scanId) {
    const subscription = this.subscriptions.get(scanId);
    if (subscription) subscription.cancelled = true;
    return this.serialize(() => this.stopInternal(scanId));
  }

  async stopInternal(scanId) {
    const current = this.subscriptions.get(scanId);
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    this.subscriptions.delete(scanId);
    this.emitState('stopping', scanId);
    if (!this.subscriptions.size && this.discovering) await this.stopPhysicalDiscovery();
    if (!this.subscriptions.size && this.unsubscribeDevice) {
      this.unsubscribeDevice();
      this.unsubscribeDevice = null;
    }
    this.emitState(this.discovering ? 'scanning' : 'idle', scanId);
  }

  async stopPhysicalDiscovery() {
    try {
      await this.platform.stopDiscovery();
    } finally {
      this.discovering = false;
    }
  }

  stopAll() {
    this.generation += 1;
    const wasDiscovering = this.discovering;
    this.discovering = false;
    this.subscriptions.forEach((item) => {
      item.cancelled = true;
      if (item.timer) clearTimeout(item.timer);
    });
    return this.serialize(() => this.stopAllInternal(wasDiscovering));
  }

  async stopAllInternal(wasDiscovering) {
    this.subscriptions.clear();
    try {
      await this.platform.stopDiscovery();
    } catch (error) {
      if (wasDiscovering) throw error;
    }
    this.discovering = false;
    if (this.unsubscribeDevice) this.unsubscribeDevice();
    this.unsubscribeDevice = null;
    this.emitState('idle');
  }

  handleFound(event) {
    const found = event && event.devices ? event.devices : [event];
    found.filter(Boolean).forEach((source) => {
      const device = normalizeDevice(source);
      if (!device.deviceId) return;
      const merged = Object.assign({}, this.devices.get(device.deviceId) || {}, device);
      this.devices.set(device.deviceId, merged);
      this.subscriptions.forEach((subscription) => {
        if (matches(merged, subscription.options) && typeof subscription.options.onDevice === 'function') {
          subscription.options.onDevice(merged, subscription.id);
        }
      });
    });
  }

  getDevices(filter) {
    return Array.from(this.devices.values())
      .filter((device) => matches(device, filter || {}))
      .sort((a, b) => (b.RSSI || -999) - (a.RSSI || -999));
  }

  clearDevices() { this.devices.clear(); }

  getState(status, scanId) {
    return {
      status: status || (this.discovering ? 'scanning' : 'idle'),
      scanId,
      discovering: this.discovering,
      subscriptionCount: this.subscriptions.size,
    };
  }

  emitState(status, scanId) {
    if (this.onStateChange) this.onStateChange(this.getState(status, scanId));
  }
}