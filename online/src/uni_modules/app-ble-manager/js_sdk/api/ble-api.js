const EVENT_MAP = {
  stateChanged: 'publicStateChanged',
  scanStateChanged: 'publicScanStateChanged',
  deviceFound: 'publicDeviceFound',
  error: 'publicError',
};

const PUBLIC_SCAN_KEYS = [
  'nameContains',
  'serviceUUIDs',
  'minRssi',
  'timeout',
  'allowDuplicatesKey',
];

function toPublicScanOptions(options) {
  const source = options || {};
  return PUBLIC_SCAN_KEYS.reduce((result, key) => {
    if (source[key] !== undefined) result[key] = source[key];
    return result;
  }, {});
}

export default function createBleApi(manager) {
  return Object.freeze({
    initialize: () => manager.initialize(),
    getBluetoothState: () => manager.getBluetoothState(),
    requestEnableSystemBluetooth: () => manager.requestEnableSystemBluetooth(),
    requestDisableSystemBluetooth: (options) => manager.requestDisableSystemBluetooth(options),
    startScan: (options) => manager.startScan(toPublicScanOptions(options)),
    stopScan: (scanId) => manager.stopScan(scanId),
    on(eventName, handler) {
      const internalName = EVENT_MAP[eventName];
      if (!internalName) throw new Error(`不支持的 BLE 事件：${eventName}`);
      if (typeof handler !== 'function') throw new TypeError(`BLE 事件 ${eventName} 的 handler 必须是函数`);
      if (eventName === 'deviceFound') {
        return manager.dispatcher.on(internalName, (payload) => handler(payload.device, payload));
      }
      return manager.dispatcher.on(internalName, handler);
    },
  });
}