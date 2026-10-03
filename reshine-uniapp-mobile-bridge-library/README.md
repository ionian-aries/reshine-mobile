# uni-app 移动端桥接库

面向 Vue 2 / LCAP H5 页面的依赖库。当前依赖库的主要功能是，暴露nasl逻辑，支持在 H5 侧加载 uni WebView SDK，建立 `app-capability-bridge` RPC 通道，并把扫码、蓝牙、电子秤和打印能力作为 NASL 逻辑提供给页面。原生能力由宿主 uni-app 工程的 `app-capability-bridge`、`app-ble-manager` 等 `uni_modules` 实现。


### Bridge 与环境

- `bridge_init(sdkUrl?, timeout?)`：加载 SDK，并以固定 `legacy-owner` 建立或复用 H5 Bridge。
- `bridge_destroy(ownerToken?)`：释放 owner；无剩余 owner 时销毁 Bridge。
- `env_getInfo()`：自动初始化并返回 `env`、`isApp`、`source`。
- `env_isApp()`：返回 Bridge 握手是否确认运行于 App。
- `env_getAppInfo()`：与其他业务逻辑相同，仅调用 App Bridge 并直接返回 UniApp 侧生成的 `{ status, code, message, data: { appid, apkVersion, wgtVersion } }` 标准结果；应用信息读取、错误标准化和敏感详情收敛均由 UniApp 侧统一处理。Bridge 传输错误仍按通用 `invoke` 行为 reject。

### 扫码

- `scan_start(softTrigger=true, timeout?, profile?, scanner='internal')`：启动扫码；新调用会先取消旧会话。
- `scan_cancel()`：取消当前扫码会话。

### 蓝牙

- `bluetooth_getState()`：获取蓝牙启用状态。
- `bluetooth_enable()`：请求开启蓝牙。
- `bluetooth_disable()`：请求关闭蓝牙。
- `bluetooth_search(name?, timeout=5000, excludeUnnamed=true)`：搜索、过滤蓝牙设备。

### 电子秤

- `scale_connect(deviceId)`：连接指定电子秤。
- `scale_disconnect()`：断开电子秤。
- `scale_status()`：查询连接、忙碌、当前操作及稳定读数状态。
- `scale_readWeight(timeout=5000)`：读取重量和原始帧信息。

### 打印

- `printer_connect(deviceId)`：连接指定打印机；内部固定发送空名称和 12 秒连接超时。
- `printer_disconnect()`：断开打印机。
- `printer_status()`：查询连接、忙碌及当前打印任务状态。
- `printer_print(image, width=80, height=40, orientation=90, copies?, gapType?, printDarkness?, printSpeed?, threshold=180)`：校验并提交图片打印。
- `printer_capture(refName)`：纯 H5 DOM 截图，返回 PNG Data URL、像素尺寸和字节数，不经过 App RPC。

业务 RPC 统一返回 `{ status, code, message, data }`；`env_getAppInfo` 的 `data` 包含 `appid`、`apkVersion`、`wgtVersion`。`printer_print` 接受 PNG/JPEG/WebP Data URL 或 HTTP(S) URL；解码后上限为 5 MiB。超过 128 KiB 的 Data URL 会在库内通过 `transfer.start/chunk/complete/abort` 按 48 KiB 目标片长传输，并校验 SHA-256。


## 与 online / local 的组合关系

- H5 侧：本库发送 RPC，并负责 H5 生命周期、参数校验、打印图片分片和 DOM 截图。
- App 侧：`online/src/uni_modules/app-capability-bridge` 与 `local/src/uni_modules/app-capability-bridge` 注册同一组业务 action，并经 `app-ble-manager` 调用扫码、蓝牙、电子秤和打印能力。
- `online`：首页的 `app-capability-bridge-shell` 加载 `VUE_APP_WEBVIEW_URL` 指向的远程 H5。
- `local`：同一 shell 加载 APK 内的 `/hybrid/html/index.html`。

两种宿主方式只改变 H5 来源；H5 与 App 的 Bridge 协议及业务 action 清单相同。宿主工程不通过 npm 直接调用本包，而是由 shell 承接本库从 WebView 发出的消息并执行原生侧 action。

## 构建与验证

`vite.config.js` 以 `src/index.ts` 为库入口，目标为 Vue 2 LCAP extension；`package.json` 的 `main`、`module` 和 `files` 均指向 `dist-theme`。

```bash
npm install
npm run test:run
npm run typecheck
npm run build
```

`npm run build` 会生成 `dist-theme` 和 `nasl.extension.json`、执行公开 API 编译，并通过 `npm pack` 生成发布包。`tsconfig.api.json` 仍保留 `src/logics/api.ts` include，但当前公开逻辑的代码入口实际为 `src/logics/index.ts`；维护导出时应同步核对构建产物。