import '@nasl/types';
import { assertBoolean, assertInteger, assertString, invoke } from './capability-client';

type ScanData = { data: nasl.core.String; codeId: nasl.core.String; aimId: nasl.core.String; charset: nasl.core.String };
let generation = 0;
let inflight = false;

/**
 * @NaslLogic
 * @type h5
 * @title 扫码
 * @description 发起 Honeywell DCS 扫码；重复调用会先取消旧会话。
 * @param softTrigger 是否软件触发
 * @param timeout 超时毫秒数
 * @param profile DCS Profile
 * @param scanner internal/external/auto
 * @returns 扫码结果
 */
export async function scan_start(softTrigger: nasl.core.Boolean = true, timeout?: nasl.core.Integer, profile?: nasl.core.String, scanner: nasl.core.String = 'internal'): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: { data: nasl.core.String; codeId: nasl.core.String; aimId: nasl.core.String; charset: nasl.core.String } }> {
  const soft = assertBoolean(softTrigger, 'softTrigger', true);
  const duration = assertInteger(timeout, 'timeout', 1, 300000, soft ? 15000 : 120000);
  const selected = assertString(scanner || 'internal', 'scanner');
  if (!['internal', 'external', 'auto'].includes(selected)) throw new Error('scanner 参数无效');
  const profileName = profile === undefined || profile === null || profile === '' ? '' : assertString(profile, 'profile', false, 256);
  const mine = ++generation;
  if (inflight) { try { await invoke('scan_cancel', undefined, 5000); } catch (_) {} }
  if (mine !== generation) return { status: 'error', code: 'SCAN_CANCELLED', message: 'preempted', data: { data: '', codeId: '', aimId: '', charset: '' } };
  inflight = true;
  try { return await invoke('scan_start', { softTrigger: soft, timeout: duration, profile: profileName, scanner: selected }, duration + 3000); }
  finally { if (mine === generation) inflight = false; }
}

/**
 * @NaslLogic
 * @type h5
 * @title 取消扫码
 * @description 取消当前扫码会话。
 * @returns 取消结果
 */
export async function scan_cancel(): Promise<{ status: nasl.core.String; code: nasl.core.String; message: nasl.core.String; data: {} }> {
  generation++; inflight = false;
  return invoke('scan_cancel', undefined, 5000);
}