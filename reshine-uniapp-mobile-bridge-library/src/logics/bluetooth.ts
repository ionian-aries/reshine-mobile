import '@nasl/types';
import { assertBoolean, assertInteger, assertString, invoke } from './capability-client';

/**
 * @NaslLogic
 * @type h5
 * @title 获取蓝牙状态
 * @returns 旧版蓝牙状态结果
 */
export async function bluetooth_getState(): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: { enabled: nasl.core.Boolean };
}> {
  return invoke('bluetooth_getState');
}
/**
 * @NaslLogic
 * @type h5
 * @title 打开蓝牙
 * @returns 旧版蓝牙操作结果
 */
export async function bluetooth_enable(): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: { enabled: nasl.core.Boolean; pending: nasl.core.Boolean };
}> {
  return invoke('bluetooth_enable');
}
/**
 * @NaslLogic
 * @type h5
 * @title 关闭蓝牙
 * @returns 旧版蓝牙操作结果
 */
export async function bluetooth_disable(): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: { enabled: nasl.core.Boolean; pending: nasl.core.Boolean };
}> {
  return invoke('bluetooth_disable');
}
/**
 * @NaslLogic
 * @type h5
 * @title 搜索蓝牙设备
 * @param name 名称过滤
 * @param timeout 搜索毫秒数，默认 5000
 * @param excludeUnnamed 是否排除无名称设备，默认 true
 * @returns 搜索结果
 */
export async function bluetooth_search(
  name?: nasl.core.String,
  timeout?: nasl.core.Integer,
  excludeUnnamed: nasl.core.Boolean = true,
): Promise<{
  status: nasl.core.String;
  code: nasl.core.String;
  message: nasl.core.String;
  data: {
    devices: nasl.collection.List<{
      deviceId: nasl.core.String;
      name: nasl.core.String;
      localName: nasl.core.String;
      rssi: nasl.core.Integer;
      connected: nasl.core.Boolean;
      paired: nasl.core.Boolean;
    }>;
  };
}> {
  return invoke('bluetooth_search', {
    name: name === undefined ? '' : assertString(name, 'name', false),
    timeout: assertInteger(timeout, 'timeout', 100, 60000, 5000),
    excludeUnnamed: assertBoolean(excludeUnnamed, 'excludeUnnamed', true),
  });
}
