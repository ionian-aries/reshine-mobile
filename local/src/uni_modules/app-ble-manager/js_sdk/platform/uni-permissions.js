import { ErrorCodes } from '../errors/codes';
import { createBleError, normalizeError } from '../errors/normalize';

export default class UniPermissions {
  // 只负责 App 访问 BLE 所需的运行时权限，不负责开启系统蓝牙或打开 App BLE 会话。
  async requestBlePermissions() {
    // 非 Android App 环境不调用 plus.android；具体 BLE 能力由后续平台 API 判断。
    if (typeof plus === 'undefined' || !plus.android || typeof uni.getSystemInfoSync !== 'function') {
      return { granted: true, permissions: [] };
    }
    const system = uni.getSystemInfoSync();
    if (system.platform !== 'android') return { granted: true, permissions: [] };

    // Android 12（API 31）开始使用附近设备权限；旧版本扫描通常依赖定位权限。
    const apiLevel = Number(system.osAndroidAPILevel || 0);
    const permissions = apiLevel >= 31
      ? ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT']
      : ['android.permission.ACCESS_FINE_LOCATION'];

    return new Promise((resolve, reject) => {
      plus.android.requestPermissions(permissions, (result) => {
        const deniedAlways = result.deniedAlways || [];
        const deniedPresent = result.deniedPresent || [];
        if (deniedAlways.length || deniedPresent.length) {
          reject(createBleError(ErrorCodes.PERMISSION_DENIED, '蓝牙权限未授权', {
            deniedAlways,
            deniedPresent,
            recoverable: !deniedAlways.length,
          }));
          return;
        }
        resolve({ granted: true, permissions: result.granted || permissions });
      }, (error) => reject(normalizeError(error, ErrorCodes.PERMISSION_DENIED)));
    });
  }
}