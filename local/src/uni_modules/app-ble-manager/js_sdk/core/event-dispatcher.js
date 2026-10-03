function fullGattKey(event) {
  return [event.deviceId || '', event.serviceId || '', event.characteristicId || '']
    .map((value) => String(value).toLowerCase())
    .join('|');
}

export default class EventDispatcher {
  constructor(platform) {
    this.platform = platform;
    this.listeners = new Map();
    this.notificationListeners = new Map();
    this.registered = false;
    this.handlers = {
      adapter: (event) => this.emit('adapterStateChanged', event),
      device: (event) => this.emit('deviceFound', event),
      connection: (event) => this.emit('connectionChanged', event),
      characteristic: (event) => {
        const listeners = this.notificationListeners.get(fullGattKey(event));
        if (listeners) Array.from(listeners.values()).forEach((handler) => {
          try { handler(event.value, event); } catch (error) { this.emit('notificationHandlerError', { error, event }); }
        });
        this.emit('characteristicChanged', event);
      },
    };
  }

  register() {
    if (this.registered) return;
    this.platform.on('onBluetoothAdapterStateChange', this.handlers.adapter);
    this.platform.on('onBluetoothDeviceFound', this.handlers.device);
    this.platform.on('onBLEConnectionStateChange', this.handlers.connection);
    this.platform.on('onBLECharacteristicValueChange', this.handlers.characteristic);
    this.registered = true;
  }

  unregister() {
    if (!this.registered) return;
    this.platform.off('offBluetoothAdapterStateChange', this.handlers.adapter);
    this.platform.off('offBluetoothDeviceFound', this.handlers.device);
    this.platform.off('offBLEConnectionStateChange', this.handlers.connection);
    this.platform.off('offBLECharacteristicValueChange', this.handlers.characteristic);
    this.registered = false;
    this.listeners.clear();
    this.notificationListeners.clear();
  }

  on(eventName, handler) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    this.listeners.get(eventName).add(handler);
    return () => this.off(eventName, handler);
  }

  off(eventName, handler) {
    const listeners = this.listeners.get(eventName);
    if (!listeners) return;
    listeners.delete(handler);
    if (!listeners.size) this.listeners.delete(eventName);
  }

  emit(eventName, payload) {
    const listeners = this.listeners.get(eventName);
    if (!listeners) return;
    Array.from(listeners).forEach((handler) => {
      try { handler(payload); } catch (error) { console.error('[app-ble-manager] event handler error', error); }
    });
  }

  subscribeNotification(key, handler) {
    const id = `notify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const registryKey = fullGattKey(key);
    if (!this.notificationListeners.has(registryKey)) this.notificationListeners.set(registryKey, new Map());
    this.notificationListeners.get(registryKey).set(id, handler);
    return id;
  }

  unsubscribeNotification(subscriptionId) {
    this.notificationListeners.forEach((listeners, key) => {
      listeners.delete(subscriptionId);
      if (!listeners.size) this.notificationListeners.delete(key);
    });
  }

  removeDevice(deviceId) {
    const prefix = `${String(deviceId).toLowerCase()}|`;
    Array.from(this.notificationListeners.keys()).forEach((key) => {
      if (key.indexOf(prefix) === 0) this.notificationListeners.delete(key);
    });
  }
}