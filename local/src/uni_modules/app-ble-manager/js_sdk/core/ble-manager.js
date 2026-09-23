import UniBlePlatform from '../platform/uni-ble';
import UniPermissions from '../platform/uni-permissions';
import UniSystemBluetooth from '../platform/uni-system-bluetooth';
import EventDispatcher from './event-dispatcher';
import Scanner from './scanner';
import ConnectionRegistry from './connection-registry';
import SharedTransport from './shared-transport';
import { ErrorCodes } from '../errors/codes';
import { createBleError, normalizeError, toPublicError } from '../errors/normalize';

export default class BleManager {
  constructor(options) {
    this.options = options || {};
    this.platform = this.options.platform || new UniBlePlatform();
    this.permissions = this.options.permissions || new UniPermissions();
    this.systemBluetooth = this.options.systemBluetooth || new UniSystemBluetooth(this.platform);
    this.dispatcher = new EventDispatcher(this.platform);
    this.registry = new ConnectionRegistry();
    this.scanner = new Scanner(this.platform, this.dispatcher, (state) => this.handleScanState(state));
    this.transport = new SharedTransport(this, this.platform, this.registry, this.dispatcher, this.scanner);
    this.initialized = false;
    this.sessionOpened = false;
    this.sessionOpening = false;
    this.shuttingDown = false;
    this.lifecycleGeneration = 0;
    this.lastAdapterAvailable = undefined;
    this.lifecycleState = 'idle';
    this.initializePromise = null;
    this.shutdownPromise = null;
    this.permissionGranted = false;
    this.supported = true;
    this.systemEnabled = false;
    this.sessionQueue = Promise.resolve();
    this.domainCleaners = new Map();
    this.unsubscribers = [];
    this.adapterUnavailableCleanup = null;
  }

  serializeSession(task) {
    const result = this.sessionQueue.then(task, task);
    this.sessionQueue = result.catch(() => undefined);
    return result;
  }

  assertAvailable(generation) {
    if (this.shuttingDown || this.lifecycleState === 'shutting-down') {
      throw createBleError(ErrorCodes.APP_SHUTTING_DOWN, 'App BLE 正在关闭');
    }
    if (generation !== undefined && generation !== this.lifecycleGeneration) {
      throw createBleError(ErrorCodes.OPERATION_CANCELLED, 'BLE 生命周期已变化，操作已取消', { recoverable: true });
    }
  }

  captureGeneration() { return this.lifecycleGeneration; }

  registerGlobalListeners() {
    if (this.initialized) return;
    this.dispatcher.register();
    this.unsubscribers.push(this.dispatcher.on('adapterStateChanged', (state) => this.handleAdapterState(state)));
    this.unsubscribers.push(this.dispatcher.on('connectionChanged', (event) => this.handleConnectionState(event)));
    this.initialized = true;
  }

  initialize() {
    this.assertAvailable();
    if (this.initializePromise) return this.initializePromise;
    if (this.initialized && this.sessionOpened) return this.getBluetoothState();
    this.lifecycleState = 'initializing';
    this.initializePromise = (async () => {
      try {
        if (!this.permissionGranted) {
          const permission = await this.permissions.requestBlePermissions();
          this.assertAvailable();
          this.permissionGranted = !!permission.granted;
        }
        this.registerGlobalListeners();
        const state = await this.openAppBleSession();
        this.lifecycleState = 'ready';
        return state;
      } catch (error) {
        this.lifecycleState = this.initialized ? 'initialized' : 'idle';
        this.emitError(error);
        throw error;
      } finally {
        this.initializePromise = null;
      }
    })();
    return this.initializePromise;
  }

  openAppBleSession() {
    this.assertAvailable();
    const generation = this.captureGeneration();
    return this.serializeSession(async () => {
      this.assertAvailable(generation);
      this.registerGlobalListeners();
      const permission = await this.requestPermissions();
      this.assertAvailable(generation);
      this.permissionGranted = !!permission.granted;
      if (!this.sessionOpened) {
        try {
          this.sessionOpening = true;
          await this.platform.openAdapter();
          if (generation !== this.lifecycleGeneration || this.shuttingDown) {
            await this.platform.closeAdapter().catch(() => undefined);
            this.assertAvailable(generation);
          }
          this.sessionOpened = true;
          this.sessionOpening = false;
          this.systemEnabled = true;
        } catch (error) {
          this.sessionOpening = false;
          const normalized = normalizeError(error, ErrorCodes.ADAPTER_OPEN_FAILED);
          if (normalized.code === ErrorCodes.SYSTEM_BLUETOOTH_DISABLED) this.systemEnabled = false;
          throw normalized;
        }
      }
      const state = await this.refreshAdapterState();
      this.emitState();
      return state;
    });
  }

  closeAppBleSession(options) {
    const opts = options || {};
    return this.serializeSession(async () => {
      if (this.registry.hasActiveConnections() && opts.disconnectAll !== true) {
        throw createBleError(ErrorCodes.ACTIVE_CONNECTIONS_EXIST, '存在活动设备连接，请通过领域服务断开或显式传入 disconnectAll: true');
      }
      if (opts.disconnectAll === true) await this.disconnectAllThroughOwners();
      await this.scanner.stopAll();
      if (this.sessionOpened) {
        try {
          await this.platform.closeAdapter();
        } finally {
          this.sessionOpened = false;
          this.lifecycleGeneration += 1;
          this.lifecycleState = this.initialized ? 'initialized' : 'idle';
        }
      }
      this.emitState();
    });
  }

  async getBluetoothState() {
    await this.refreshSystemBluetoothState();
    if (this.sessionOpened && this.systemEnabled) await this.refreshAdapterState();
    return this.buildState();
  }

  refreshSystemBluetoothState() {
    try {
      const enabled = this.systemBluetooth.isEnabled();
      this.systemEnabled = enabled;
      this.lastAdapterAvailable = enabled;
      if (!enabled) this.sessionOpened = false;
      return enabled;
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.SYSTEM_BLUETOOTH_UNSUPPORTED);
      if (normalized.code === ErrorCodes.PERMISSION_DENIED) {
        this.permissionGranted = false;
        throw normalized;
      }
      if (normalized.code === ErrorCodes.BLE_NOT_SUPPORTED) this.supported = false;
      return this.systemEnabled;
    }
  }

  async refreshAdapterState() {
    try {
      const state = await this.platform.getAdapterState();
      this.systemEnabled = !!state.available;
      return this.buildState(state.discovering);
    } catch (error) {
      const normalized = normalizeError(error, ErrorCodes.ADAPTER_OPEN_FAILED);
      if (normalized.code === ErrorCodes.PERMISSION_DENIED) {
        this.permissionGranted = false;
        throw normalized;
      }
      if (normalized.code === ErrorCodes.SYSTEM_BLUETOOTH_DISABLED) this.systemEnabled = false;
      return this.buildState();
    }
  }

  buildState(discovering) {
    return {
      supported: this.supported,
      permissionGranted: this.permissionGranted,
      systemEnabled: this.systemEnabled,
      appSessionOpened: this.sessionOpened,
      discovering: discovering === undefined ? this.scanner.discovering : !!discovering,
      connectedDeviceCount: this.registry.active().length,
    };
  }

  async requestPermissions() {
    const state = await this.permissions.requestBlePermissions();
    this.permissionGranted = !!state.granted;
    this.emitState();
    return state;
  }

  async requestEnableSystemBluetooth() {
    this.assertAvailable();
    await this.requestPermissions();
    await this.systemBluetooth.requestEnable();
    this.systemEnabled = true;
    this.lastAdapterAvailable = true;
    if (!this.sessionOpened) await this.openAppBleSession();
    const state = await this.getBluetoothState();
    this.emitState();
    return state;
  }

  async requestDisableSystemBluetooth(options) {
    this.assertAvailable();
    const opts = options || {};
    if (this.registry.hasActiveConnections() && opts.force !== true) {
      throw createBleError(ErrorCodes.ACTIVE_CONNECTIONS_EXIST, '存在活动设备连接；确认中断全部 BLE 任务后，请显式传入 force: true');
    }
    await this.requestPermissions();
    await this.systemBluetooth.requestDisable();
    if (this.systemEnabled || this.sessionOpened || this.lastAdapterAvailable !== false) {
      this.systemEnabled = false;
      this.sessionOpened = false;
      this.lastAdapterAvailable = false;
      this.lifecycleGeneration += 1;
      this.lifecycleState = this.initialized ? 'initialized' : 'idle';
    }
    const cleanup = this.cleanupAfterAdapterUnavailable();
    this.emitState();
    await cleanup;
    return this.buildState(false);
  }

  startScan(options) {
    this.assertAvailable();
    const source = options || {};
    return this.ensureSystemBluetoothAvailable()
      .then(() => this.openAppBleSession())
      .then(() => this.scanner.start(Object.assign({}, source, {
        owner: 'ble',
        onDevice: (device, scanId) => this.dispatcher.emit('publicDeviceFound', { device, scanId, owner: 'ble' }),
      })));
  }

  async ensureSystemBluetoothAvailable() {
    await this.refreshSystemBluetoothState();
    if (!this.systemEnabled) {
      throw createBleError(ErrorCodes.SYSTEM_BLUETOOTH_DISABLED, '系统蓝牙已关闭，请先打开系统蓝牙', { recoverable: true });
    }
  }

  stopScan(scanId) { return this.scanner.stop(scanId); }
  registerDomainCleaner(owner, cleaner) { this.domainCleaners.set(owner, cleaner); return () => this.domainCleaners.delete(owner); }

  async disconnectAllThroughOwners() {
    const active = this.registry.active();
    const owners = Array.from(new Set(active.map((item) => item.owner).filter(Boolean)));
    for (let index = 0; index < owners.length; index += 1) {
      const cleaner = this.domainCleaners.get(owners[index]);
      if (typeof cleaner !== 'function') {
        throw createBleError(ErrorCodes.ACTIVE_CONNECTIONS_EXIST, `设备领域 ${owners[index]} 未注册清理函数`);
      }
      await cleaner();
    }
    const unmanaged = active.filter((item) => !item.owner);
    for (let index = 0; index < unmanaged.length; index += 1) {
      await this.transport.disconnect(undefined, unmanaged[index].deviceId);
    }
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.lifecycleState = 'shutting-down';
    this.lifecycleGeneration += 1;
    this.shutdownPromise = this.serializeSession(async () => {
      let shutdownError;
      try {
        await this.scanner.stopAll().catch((error) => this.emitError(error));
        try {
          await this.disconnectAllThroughOwners();
        } catch (error) {
          shutdownError = error;
          this.emitError(error);
        }
        if (this.sessionOpened) await this.platform.closeAdapter().catch((error) => this.emitError(error));
        this.sessionOpened = false;
        this.registry.clear();
        this.unsubscribers.forEach((unsubscribe) => unsubscribe());
        this.unsubscribers = [];
        this.dispatcher.unregister();
        this.initialized = false;
        this.lifecycleState = 'idle';
        if (shutdownError) throw shutdownError;
      } finally {
        this.shuttingDown = false;
      }
    }).finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  handleAdapterState(state) {
    const available = !!state.available;
    const becameUnavailable = this.lastAdapterAvailable !== false && !available;
    this.lastAdapterAvailable = available;
    this.systemEnabled = available;
    if (becameUnavailable && !this.sessionOpening && !this.shuttingDown) {
      this.sessionOpened = false;
      this.lifecycleGeneration += 1;
      this.lifecycleState = this.initialized ? 'initialized' : 'idle';
      this.cleanupAfterAdapterUnavailable();
    } else if (available && this.initialized && this.sessionOpened) {
      this.lifecycleState = 'ready';
    }
    this.emitState();
  }

  cleanupAfterAdapterUnavailable() {
    if (this.adapterUnavailableCleanup) return this.adapterUnavailableCleanup;
    const active = this.registry.active();
    this.adapterUnavailableCleanup = (async () => {
      await this.scanner.stopAll().catch((error) => this.emitError(error));
      const owners = Array.from(new Set(active.map((item) => item.owner).filter(Boolean)));
      for (let index = 0; index < owners.length; index += 1) {
        const cleaner = this.domainCleaners.get(owners[index]);
        if (typeof cleaner === 'function') await cleaner().catch((error) => this.emitError(error));
      }
      active.forEach((session) => {
        const current = this.registry.get(session.deviceId);
        if (!current) return;
        this.transport.clearDeviceGattResources(session.deviceId);
        this.dispatcher.removeDevice(session.deviceId);
        current.connected = false;
        current.state = 'disconnected';
        const publicState = this.registry.toPublic(current);
        this.dispatcher.emit('domainConnectionChanged', Object.assign({}, publicState, {
          previousState: session.state,
          manuallyDisconnected: false,
          timestamp: Date.now(),
        }));
        this.dispatcher.emit('publicConnectionChanged', publicState);
        this.registry.remove(session.deviceId);
      });
      this.emitState();
    })().finally(() => {
      this.adapterUnavailableCleanup = null;
    });
    return this.adapterUnavailableCleanup;
  }

  handleScanState(state) {
    this.dispatcher.emit('publicScanStateChanged', state);
    this.emitState();
  }

  handleConnectionState(event) {
    const previous = this.registry.get(event && event.deviceId);
    const previousState = previous && previous.state;
    const session = this.registry.updateConnection(event);
    if (session && !event.connected) {
      this.transport.clearDeviceGattResources(event.deviceId);
      this.dispatcher.removeDevice(event.deviceId);
    }
    const publicState = this.registry.toPublic(session);
    this.dispatcher.emit('domainConnectionChanged', Object.assign({}, publicState, {
      previousState,
      manuallyDisconnected: !!(session && session.manuallyDisconnected),
      timestamp: Date.now(),
    }));
    this.dispatcher.emit('publicConnectionChanged', publicState);
    this.emitState();
  }

  emitState() { this.dispatcher.emit('publicStateChanged', this.buildState()); }
  emitError(error) { this.dispatcher.emit('publicError', toPublicError(error)); }
}