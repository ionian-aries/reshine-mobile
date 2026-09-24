import '@nasl/types';
import { assertInteger, assertString, invoke } from './capability-client';

/**
 * @NaslLogic
 * @type h5
 * @title 连接电子秤
 * @param deviceId 设备 ID
 * @returns 连接结果
 */
export async function scale_connect(deviceId: nasl.core.String): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { deviceId: nasl.core.String; serviceId: nasl.core.String } }> { return invoke('scale_connect', { deviceId: assertString(deviceId, 'deviceId') }); }
/**
 * @NaslLogic
 * @type h5
 * @title 断开电子秤
 * @returns 断开结果
 */
export async function scale_disconnect(): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { disconnected: nasl.core.Boolean; alreadyDisconnected: nasl.core.Boolean; deviceId: nasl.core.String } }> { return invoke('scale_disconnect'); }
/**
 * @NaslLogic
 * @type h5
 * @title 获取电子秤状态
 * @returns 电子秤状态
 */
export async function scale_status(): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { connected: nasl.core.Boolean; busy: nasl.core.Boolean; activeOperation: nasl.core.String; deviceId: nasl.core.String; deviceName: nasl.core.String; serviceId: nasl.core.String; hasStableWeight: nasl.core.Boolean } }> { return invoke('scale_status'); }
/**
 * @NaslLogic
 * @type h5
 * @title 读取重量
 * @param timeout 超时毫秒数，默认 5000
 * @returns 称重结果
 */
export async function scale_readWeight(timeout?: nasl.core.Integer): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { overload: nasl.core.Boolean; stable: nasl.core.Boolean; weight: nasl.core.String; unit: nasl.core.String; weightType: nasl.core.String; raw: nasl.core.String } }> { return invoke('scale_readWeight', { timeout: assertInteger(timeout, 'timeout', 100, 60000, 5000) }, 65000); }