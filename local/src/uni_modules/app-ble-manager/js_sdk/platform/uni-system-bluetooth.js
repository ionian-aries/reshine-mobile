import { ErrorCodes } from '../errors/codes';
import { createBleError, normalizeError } from '../errors/normalize';

// Activity 请求码由本插件自行定义，只用于区分开启和关闭请求的返回结果。
const REQUEST_ENABLE_BLUETOOTH = 0x4251;
const REQUEST_DISABLE_BLUETOOTH = 0x4252;

// Android 提供公开的开启确认 Action，但未公开稳定的关闭常量；关闭字符串存在版本和厂商兼容风险。
const REQUEST_DISABLE_ACTION = 'android.bluetooth.adapter.action.REQUEST_DISABLE';

// Android 蓝牙状态广播及其状态字段。
const BLUETOOTH_STATE_ACTION = 'android.bluetooth.adapter.action.STATE_CHANGED';
const BLUETOOTH_STATE_EXTRA = 'android.bluetooth.adapter.extra.STATE';

// 对应 android.bluetooth.BluetoothAdapter.STATE_OFF / STATE_ON 的固定值。
const BLUETOOTH_STATE_OFF = 10;
const BLUETOOTH_STATE_ON = 12;

// 给用户确认和蓝牙硬件切换预留的最长等待时间。
const TOGGLE_TIMEOUT = 30000;

// HBuilderX 没有独立的 Activity Result 订阅 API，这里临时代理并在请求结束后恢复原处理器。
function setActivityResultHandler(activity, handler) {
  if (!activity || typeof activity.onActivityResult !== 'function') return null;
  const previous = activity.onActivityResult;
  const listener = function(requestCode, resultCode, data) {
    if (typeof previous === 'function') previous.call(this, requestCode, resultCode, data);
    handler(requestCode, resultCode, data);
  };
  activity.onActivityResult = listener;
  return () => {
    if (activity.onActivityResult === listener) activity.onActivityResult = previous;
  };
}

export default class UniSystemBluetooth {
  // 只负责手机系统蓝牙开关，不负责运行时权限、App BLE 会话或设备连接。
  constructor(platform) {
    this.platform = platform;
    this.pending = { enable: null, disable: null };
  }

  isAndroidApp() {
    if (typeof plus === 'undefined' || !plus.android || typeof uni.getSystemInfoSync !== 'function') return false;
    return uni.getSystemInfoSync().platform === 'android';
  }

  getNativeContext() {
    if (!this.isAndroidApp()) {
      throw createBleError(ErrorCodes.SYSTEM_BLUETOOTH_UNSUPPORTED, '当前平台不支持由 App 请求切换系统蓝牙');
    }
    const BluetoothAdapter = plus.android.importClass('android.bluetooth.BluetoothAdapter');
    const adapter = BluetoothAdapter.getDefaultAdapter();
    if (!adapter) throw createBleError(ErrorCodes.BLE_NOT_SUPPORTED, '当前设备不支持蓝牙');
    return {
      activity: plus.android.runtimeMainActivity(),
      adapter,
      BluetoothAdapter,
      Intent: plus.android.importClass('android.content.Intent'),
      IntentFilter: plus.android.importClass('android.content.IntentFilter'),
    };
  }

  isEnabled() {
    const context = this.getNativeContext();
    return !!context.adapter.isEnabled();
  }

  requestEnable() {
    // Android 标准开启流程：展示系统确认页，并复用进行中的请求以避免重复弹窗。
    if (this.pending.enable) return this.pending.enable;
    const context = this.getNativeContext();
    if (context.adapter.isEnabled()) return Promise.resolve({ enabled: true, changed: false });
    this.pending.enable = this.requestToggle({
      context,
      expected: true,
      requestCode: REQUEST_ENABLE_BLUETOOTH,
      action: context.BluetoothAdapter.ACTION_REQUEST_ENABLE,
      deniedCode: ErrorCodes.SYSTEM_BLUETOOTH_ENABLE_DENIED,
      deniedMessage: '用户未允许打开系统蓝牙',
    }).finally(() => { this.pending.enable = null; });
    return this.pending.enable;
  }

  requestDisable() {
    // 请求系统展示关闭确认页；不降级调用 BluetoothAdapter.disable() 静默关闭。
    if (this.pending.disable) return this.pending.disable;
    const context = this.getNativeContext();
    if (!context.adapter.isEnabled()) return Promise.resolve({ enabled: false, changed: false });
    this.pending.disable = this.requestToggle({
      context,
      expected: false,
      requestCode: REQUEST_DISABLE_BLUETOOTH,
      action: REQUEST_DISABLE_ACTION,
      deniedCode: ErrorCodes.SYSTEM_BLUETOOTH_DISABLE_DENIED,
      deniedMessage: '用户未允许关闭系统蓝牙',
    }).finally(() => { this.pending.disable = null; });
    return this.pending.disable;
  }

  requestToggle(options) {
    // 同时观察状态广播与 Activity 返回：前者确认硬件最终状态，后者识别用户拒绝或取消。
    return new Promise((resolve, reject) => {
      const { context, expected, requestCode, action, deniedCode, deniedMessage } = options;
      let receiver;
      let restoreActivityResult;
      let timer;
      let settled = false;

      const readEnabled = () => {
        try { return !!context.adapter.isEnabled(); } catch (_) { return !expected; }
      };
      const cleanup = () => {
        // 无论成功、拒绝、超时还是异常，都必须恢复宿主回调并注销临时广播接收器。
        if (timer) clearTimeout(timer);
        if (restoreActivityResult) restoreActivityResult();
        if (receiver) {
          try { plus.android.invoke(context.activity, 'unregisterReceiver', receiver); } catch (_) { /* 已被系统解绑 */ }
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve({ enabled: expected, changed: true });
      };
      const finishFromCurrentState = () => {
        if (readEnabled() === expected) finish();
        else finish(createBleError(deniedCode, deniedMessage, { recoverable: true }));
      };

      try {
        receiver = plus.android.implements('io.dcloud.feature.internal.reflect.BroadcastReceiver', {
          onReceive: (_, intent) => {
            const receivedAction = plus.android.invoke(intent, 'getAction');
            if (receivedAction !== BLUETOOTH_STATE_ACTION) return;
            const nextState = plus.android.invoke(intent, 'getIntExtra', BLUETOOTH_STATE_EXTRA, -1);
            if (nextState === (expected ? BLUETOOTH_STATE_ON : BLUETOOTH_STATE_OFF)) finish();
          },
        });
        plus.android.invoke(context.activity, 'registerReceiver', receiver, new context.IntentFilter(BLUETOOTH_STATE_ACTION));
        restoreActivityResult = setActivityResultHandler(context.activity, (code) => {
          if (code === requestCode) finishFromCurrentState();
        });
        context.activity.startActivityForResult(new context.Intent(action), requestCode);
        timer = setTimeout(() => {
          if (readEnabled() === expected) finish();
          else finish(createBleError(ErrorCodes.SYSTEM_BLUETOOTH_CHANGE_TIMEOUT, `等待系统蓝牙${expected ? '开启' : '关闭'}超时`, { recoverable: true }));
        }, TOGGLE_TIMEOUT);
      } catch (error) {
        finish(normalizeError(error, ErrorCodes.SYSTEM_BLUETOOTH_UNSUPPORTED));
      }
    });
  }
}