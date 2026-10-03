import { ErrorCodes } from '../errors/codes';
import { createBleError, normalizeError } from '../errors/normalize';

function invoke(method, options, fallbackCode) {
  return new Promise((resolve, reject) => {
    if (typeof uni === 'undefined' || typeof uni[method] !== 'function') {
      reject(createBleError(ErrorCodes.BLE_NOT_SUPPORTED, `当前运行环境不支持 ${method}`));
      return;
    }
    uni[method](Object.assign({}, options || {}, {
      success: resolve,
      fail: (error) => reject(normalizeError(error, fallbackCode)),
    }));
  });
}

export default class UniBlePlatform {
  openAdapter() { return invoke('openBluetoothAdapter', {}, ErrorCodes.ADAPTER_OPEN_FAILED); }
  closeAdapter() { return invoke('closeBluetoothAdapter', {}, ErrorCodes.ADAPTER_CLOSE_FAILED); }
  getAdapterState() { return invoke('getBluetoothAdapterState', {}, ErrorCodes.ADAPTER_OPEN_FAILED); }
  startDiscovery(options) { return invoke('startBluetoothDevicesDiscovery', options, ErrorCodes.SCAN_START_FAILED); }
  stopDiscovery() { return invoke('stopBluetoothDevicesDiscovery', {}, ErrorCodes.SCAN_STOP_FAILED); }
  connect(deviceId, timeout) {
    return invoke('createBLEConnection', { deviceId, timeout }, ErrorCodes.CONNECT_FAILED);
  }
  disconnect(deviceId) {
    return invoke('closeBLEConnection', { deviceId }, ErrorCodes.DISCONNECT_FAILED);
  }
  getServices(deviceId) {
    return invoke('getBLEDeviceServices', { deviceId }, ErrorCodes.GATT_SERVICE_NOT_FOUND);
  }
  getCharacteristics(deviceId, serviceId) {
    return invoke('getBLEDeviceCharacteristics', { deviceId, serviceId }, ErrorCodes.GATT_CHARACTERISTIC_NOT_FOUND);
  }
  setNotify(key, state) {
    return invoke('notifyBLECharacteristicValueChange', Object.assign({}, key, { state }), ErrorCodes.NOTIFY_FAILED);
  }
  requestMtu(deviceId, mtu) {
    return invoke('setBLEMTU', { deviceId, mtu }, ErrorCodes.MTU_FAILED);
  }
  getMtu(deviceId) {
    return invoke('getBLEMTU', { deviceId }, ErrorCodes.MTU_FAILED);
  }
  read(key) {
    return invoke('readBLECharacteristicValue', key, ErrorCodes.READ_FAILED);
  }
  write(key, data, withResponse) {
    const value = data instanceof ArrayBuffer
      ? data
      : (ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    return invoke('writeBLECharacteristicValue', Object.assign({}, key, {
      value,
      writeType: withResponse ? 'write' : 'writeNoResponse',
    }), ErrorCodes.WRITE_FAILED);
  }
  on(name, handler) {
    if (typeof uni !== 'undefined' && typeof uni[name] === 'function') uni[name](handler);
  }
  off(name, handler) {
    if (typeof uni !== 'undefined' && typeof uni[name] === 'function') uni[name](handler);
  }
}