import { ErrorCodes } from '../errors/codes';
import { createBleError, normalizeError, toPublicError } from '../errors/normalize';

export default class SharedTransport {
  constructor(manager, platform, registry, dispatcher, scanner) {
    this.manager = manager;
    this.platform = platform;
    this.registry = registry;
    this.dispatcher = dispatcher;
    this.scanner = scanner;
    this.notificationKeys = new Map();
    this.notificationRefCounts = new Map();
  }

  addScanSubscription(options) {
    return this.manager.ensureSystemBluetoothAvailable()
      .then(() => this.manager.openAppBleSession())
      .then(() => this.scanner.start(options));
  }
  removeScanSubscription(subscriptionId) { return this.scanner.stop(subscriptionId); }
  getFoundDevices(filter) { return this.scanner.getDevices(filter); }

  async connect(owner, deviceId, options) {
    this.manager.assertAvailable();
    await this.manager.ensureSystemBluetoothAvailable();
    const lifecycleGeneration = this.manager.captureGeneration();
    if (!deviceId) throw createBleError(ErrorCodes.INVALID_ARGUMENT, '缺少 deviceId');
    await this.manager.openAppBleSession();
    this.manager.assertAvailable(lifecycleGeneration);
    const existing = this.registry.get(deviceId);
    if (existing && existing.connected) {
      const session = this.registry.ensure(deviceId, owner, options && options.deviceType);
      session.manuallyDisconnected = false;
      return this.registry.toPublic(session);
    }
    const session = this.registry.ensure(deviceId);
    if (owner) {
      if (!session.owners) session.owners = new Set(session.owner ? [session.owner] : []);
      session.owners.add(owner);
      if (!session.owner) session.owner = owner;
    }
    if (options && options.deviceType && !session.deviceType) session.deviceType = options.deviceType;
    return session.enqueue(async () => {
      this.manager.assertAvailable(lifecycleGeneration);
      session.state = 'connecting';
      session.manuallyDisconnected = false;
      try {
        await this.platform.connect(deviceId, options && options.timeout);
        const stabilizationDelay = Math.max(0, Number(options && options.stabilizationDelay) || 0);
        if (stabilizationDelay) await delay(stabilizationDelay);
        try {
          this.manager.assertAvailable(lifecycleGeneration);
        } catch (error) {
          await this.platform.disconnect(deviceId).catch(() => undefined);
          throw error;
        }
        session.connected = true;
        session.state = 'connected';
        session.generation += 1;
        session.lastError = undefined;
        return this.registry.toPublic(session);
      } catch (error) {
        const normalized = normalizeError(error, ErrorCodes.CONNECT_FAILED);
        if (owner && session.owners) session.owners.delete(owner);
        session.connected = false;
        session.state = 'failed';
        session.lastError = toPublicError(normalized);
        if (this.registry.get(deviceId) === session && (!session.owners || !session.owners.size)) this.removeDeviceResources(deviceId);
        throw normalized;
      }
    });
  }

  async disconnect(owner, deviceId) {
    const session = this.registry.get(deviceId);
    if (!session) return { disconnected: true, physicalDisconnected: false };
    if (!session.owners) session.owners = new Set(session.owner ? [session.owner] : []);
    if (owner && !session.owners.has(owner)) {
      throw createBleError(ErrorCodes.INVALID_ARGUMENT, `设备 ${deviceId} 不属于 ${owner}`);
    }
    return session.enqueue(async () => {
      if (owner) session.owners.delete(owner);
      if (session.owners.size) {
        session.owner = session.owners.values().next().value;
        return { disconnected: true, physicalDisconnected: false, remainingOwners: Array.from(session.owners) };
      }
      session.manuallyDisconnected = true;
      session.state = 'disconnecting';
      try {
        if (session.connected) await this.platform.disconnect(deviceId);
      } finally {
        session.connected = false;
        this.removeDeviceResources(deviceId);
      }
      return { disconnected: true, physicalDisconnected: true, remainingOwners: [] };
    });
  }

  isConnected(deviceId) {
    const session = this.registry.get(deviceId);
    return !!(session && session.connected);
  }

  getServices(deviceId) {
    return this.enqueue(deviceId, async (session) => {
      const delays = [0, 250, 500, 750];
      let lastError;
      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        if (delays[attempt]) await delay(delays[attempt]);
        if (!session.connected || session.state !== 'connected') {
          throw createBleError(ErrorCodes.OPERATION_CANCELLED, `设备连接已失效：${deviceId}`, { recoverable: true });
        }
        try {
          const result = await this.platform.getServices(deviceId);
          return result.services || [];
        } catch (error) {
          lastError = error;
          if (!isConnectionNotReady(error) || attempt === delays.length - 1) throw error;
        }
      }
      throw lastError;
    });
  }

  getCharacteristics(deviceId, serviceId) {
    return this.enqueue(deviceId, async () => {
      const result = await this.platform.getCharacteristics(deviceId, serviceId);
      return result.characteristics || [];
    });
  }

  requestMtu(deviceId, mtu) {
    return this.enqueue(deviceId, async (session) => {
      let result;
      try {
        result = await this.platform.requestMtu(deviceId, mtu);
      } catch (error) {
        if (typeof this.platform.getMtu !== 'function') throw error;
        result = await this.platform.getMtu(deviceId);
      }
      const negotiated = Number(result && result.mtu) || Number(mtu) || 0;
      if (negotiated > 0) session.mtu = negotiated;
      return negotiated;
    });
  }

  read(key) {
    return this.enqueue(key.deviceId, async () => {
      await this.platform.read(key);
      return undefined;
    });
  }

  write(key, data, withResponse) {
    return this.enqueue(key.deviceId, async () => {
      await this.platform.write(key, data, withResponse !== false);
    });
  }

  subscribe(key, callback) {
    return this.enqueue(key.deviceId, async (session) => {
      const registryKey = this.makeGattKey(key);
      const count = this.notificationRefCounts.get(registryKey) || 0;
      if (count === 0) await this.platform.setNotify(key, true);
      const id = this.dispatcher.subscribeNotification(key, callback);
      this.notificationRefCounts.set(registryKey, count + 1);
      session.subscriptions.set(id, registryKey);
      this.notificationKeys.set(id, Object.assign({}, key));
      return id;
    });
  }

  unsubscribe(subscriptionId) {
    const key = this.notificationKeys.get(subscriptionId);
    if (!key) {
      this.dispatcher.unsubscribeNotification(subscriptionId);
      return Promise.resolve();
    }
    return this.enqueue(key.deviceId, async (session) => {
      this.dispatcher.unsubscribeNotification(subscriptionId);
      this.notificationKeys.delete(subscriptionId);
      const registryKey = this.makeGattKey(key);
      const nextCount = Math.max(0, (this.notificationRefCounts.get(registryKey) || 1) - 1);
      if (nextCount) this.notificationRefCounts.set(registryKey, nextCount);
      else this.notificationRefCounts.delete(registryKey);
      session.subscriptions.delete(subscriptionId);
      if (!nextCount && session.connected) await this.platform.setNotify(key, false);
    });
  }

  enqueue(deviceId, action) {
    const session = this.registry.get(deviceId);
    if (!session) return Promise.reject(createBleError(ErrorCodes.DEVICE_NOT_FOUND, `设备会话不存在：${deviceId}`));
    const generation = session.generation;
    const lifecycleGeneration = this.manager.captureGeneration();
    return session.enqueue(() => {
      this.manager.assertAvailable(lifecycleGeneration);
      if (session.generation !== generation) {
        throw createBleError(ErrorCodes.OPERATION_CANCELLED, `设备操作已取消：${deviceId}`, { recoverable: true });
      }
      return action(session);
    });
  }

  makeGattKey(key) {
    return [key.deviceId, key.serviceId, key.characteristicId].map((value) => String(value || '').toLowerCase()).join('|');
  }

  clearDeviceGattResources(deviceId) {
    const session = this.registry.get(deviceId);
    if (!session) return;
    Array.from(session.subscriptions.keys()).forEach((id) => {
      const key = this.notificationKeys.get(id);
      if (key) this.notificationRefCounts.delete(this.makeGattKey(key));
      this.notificationKeys.delete(id);
      this.dispatcher.unsubscribeNotification(id);
    });
    session.subscriptions.clear();
    this.dispatcher.removeDevice(deviceId);
  }

  removeDeviceResources(deviceId) {
    this.clearDeviceGattResources(deviceId);
    this.registry.remove(deviceId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionNotReady(error) {
  const message = String((error && (error.message || error.errMsg)) || '').toLowerCase();
  const nativeCode = Number(error && (error.nativeCode !== undefined ? error.nativeCode : error.errCode));
  return nativeCode === 10003 || nativeCode === 10006 || message.indexOf('no connection') >= 0 || message.indexOf('not connected') >= 0;
}