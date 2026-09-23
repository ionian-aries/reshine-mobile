import { ErrorCodes } from './codes';

const UNI_ERROR_CODES = {
  10000: ErrorCodes.ADAPTER_OPEN_FAILED,
  10001: ErrorCodes.SYSTEM_BLUETOOTH_DISABLED,
  10002: ErrorCodes.DEVICE_NOT_FOUND,
  10003: ErrorCodes.CONNECT_FAILED,
  10004: ErrorCodes.GATT_SERVICE_NOT_FOUND,
  10005: ErrorCodes.GATT_CHARACTERISTIC_NOT_FOUND,
  10006: ErrorCodes.CONNECT_FAILED,
  10007: ErrorCodes.CONNECT_FAILED,
  10008: ErrorCodes.SYSTEM_BLUETOOTH_DISABLED,
  10009: ErrorCodes.SYSTEM_BLUETOOTH_DISABLED,
  10012: ErrorCodes.CONNECT_TIMEOUT,
  10013: ErrorCodes.BLE_NOT_SUPPORTED,
};

const ERROR_MESSAGES = Object.freeze({
  [ErrorCodes.SYSTEM_BLUETOOTH_DISABLED]: '系统蓝牙已关闭，请先打开系统蓝牙',
});

export function createBleError(code, message, details) {
  const error = new Error(message || ERROR_MESSAGES[code] || code || ErrorCodes.UNKNOWN);
  error.name = 'BleError';
  error.code = code || ErrorCodes.UNKNOWN;
  if (details) Object.assign(error, details);
  return error;
}

export function normalizeError(error, fallbackCode, context) {
  if (error && error.name === 'BleError') {
    if (context) Object.assign(error, context);
    return error;
  }
  const nativeCode = error && (error.errCode !== undefined ? error.errCode : error.code);
  const nativeMessage = String((error && (error.errMsg || error.message)) || '');
  const permissionDenied = /permission\s+(?:denied|not\s+granted)|securityexception/i.test(nativeMessage);
  const unavailable = /(?:openBluetoothAdapter|bluetooth).*?(?:not available|unavailable)/i.test(nativeMessage);
  const code = (permissionDenied ? ErrorCodes.PERMISSION_DENIED : undefined) || UNI_ERROR_CODES[nativeCode] || (unavailable ? ErrorCodes.SYSTEM_BLUETOOTH_DISABLED : undefined) || fallbackCode || ErrorCodes.UNKNOWN;
  const message = ERROR_MESSAGES[code] || nativeMessage || code;
  return createBleError(code, message, Object.assign({ nativeCode, nativeMessage, cause: error }, context || {}));
}

export function toPublicError(error) {
  if (!error) return undefined;
  return {
    code: error.code || ErrorCodes.UNKNOWN,
    message: error.message || String(error),
    operationId: error.operationId,
    recoverable: error.recoverable !== false,
  };
}