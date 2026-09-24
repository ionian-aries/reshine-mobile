import '@nasl/types';
import { destroyH5Bridge, initH5Bridge } from '../bridge/h5-lifecycle';

/**
 * @NaslLogic
 * @type h5
 * @title 初始化 App 通信桥
 * @description 为 owner 建立或复用 H5 Bridge；同一 owner 重复调用不增加引用计数。
 * @param ownerToken 页面或应用实例的稳定所有者标识；省略时使用 legacy-owner
 * @param sdkTimeout SDK 加载超时毫秒数
 * @param connectTimeout 握手连接超时毫秒数
 * @returns Bridge 状态
 */
export async function bridge_init(
  sdkUrl?: nasl.core.String,
  timeout?: nasl.core.Integer,
): Promise<{
  ready: nasl.core.Boolean;
  env: nasl.core.String;
  isApp: nasl.core.Boolean;
  source: nasl.core.String;
}> {
  const state = await initH5Bridge({
    ownerToken: 'legacy-owner',
    sdkUrl: sdkUrl ? String(sdkUrl) : undefined,
    sdkTimeoutMs: timeout as number | undefined,
    connectTimeoutMs: timeout as number | undefined,
  });
  return { ready: state.ready, env: state.env, isApp: state.isApp, source: state.source };
}

/**
 * @NaslLogic
 * @type h5
 * @title 销毁 App 通信桥
 * @description 释放 owner；最后一个 owner 释放后销毁 Bridge、receiver 和本库创建的 SDK 节点。
 * @param ownerToken 初始化时使用的所有者标识；省略时使用 legacy-owner
 * @returns 销毁结果与剩余 owner 数量
 */
export async function bridge_destroy(ownerToken?: nasl.core.String): Promise<{ destroyed: nasl.core.Boolean; remainingOwners: nasl.core.Integer }> {
  return destroyH5Bridge(ownerToken ? String(ownerToken) : undefined);
}

/**
 * @NaslLogic
 * @type h5
 * @title 获取运行环境
 * @description 获取 App Bridge 环境信息；需要时自动初始化 legacy-owner。
 * @returns 环境信息
 */
export async function env_getInfo(): Promise<{ env: nasl.core.String; isApp: nasl.core.Boolean; source: nasl.core.String }> {
  const state = await bridge_init();
  return { env: state.env, isApp: state.isApp, source: state.source };
}

/**
 * @NaslLogic
 * @type h5
 * @title 是否运行于 App
 * @description 仅在 App Bridge 握手成功后返回 true。
 * @returns 是否运行于 App
 */
export async function env_isApp(): Promise<nasl.core.Boolean> { return (await env_getInfo()).isApp; }