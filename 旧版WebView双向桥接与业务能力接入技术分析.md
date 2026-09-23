# 旧版 WebView 双向桥接与业务能力接入技术分析

## 1. 分析目的与代码范围

本文用于指导当前项目从零重建一套纯 JavaScript 的定制能力接入管理插件，使 WebView 内 H5 能通过 LCAP 依赖库逻辑调用 uni-app 原生侧的 BLE、打印、电子秤、扫码等能力。

分析范围：

- 旧 uni-app：`/Users/zhuanghengheng/Works/8.31金川瑞翔-new/reshine-mobile-online`
- 旧 H5 依赖库：`/Users/zhuanghengheng/Works/8.31金川瑞翔-new/reshine-uniapp-mobile-bridege-library`
- 当前目标壳：`reshine-mobile/online`
- 当前目标依赖库：`reshine_uniapp_mobile_bridge_library`
- 当前 BLE 插件：`reshine-mobile/online/src/uni_modules/app-ble-manager`

结论：旧系统已经实现“H5 逻辑调用 → `uni.postMessage` → uni-app 路由 → 原生业务服务 → `evalJS` 返回”的闭环，并针对双向大 Base64 数据实现了内存分片。但旧实现存在 API 映射断链、安全边界不足、分片协议不对称、事件模型薄弱和测试不足等问题，不应原样复制。

## 2. 旧系统总体架构

### 2.1 分层

1. **H5 业务层**：调用依赖库导出的 LCAP/NASL 逻辑。
2. **H5 Bridge Client**：创建请求、保存 Promise、经 `uni.postMessage` 发往 App，接收 App 注入的回调和事件。
3. **uni-app WebView 宿主页**：接收 `@message`，执行协议校验和 action 路由。
4. **业务服务层**：`bluetooth`、`scan`、`scale`、`printer`、`result` 等服务。
5. **原生能力层**：uni BLE API、Android Intent、Honeywell 广播、德佟 LPAPI。
6. **App → H5 回传层**：uni-app 获取 H5 WebView，调用 `evalJS` 执行 `window.__bridge` 回调。

### 2.2 普通调用时序

1. H5 业务逻辑调用 `sendControl(action, params)`。
2. Bridge 生成 `reqId`，在 pending Map 注册 Promise、timer 和 resolve/reject。
3. H5 经 `uni.postMessage({ data: envelope })` 发出请求。
4. uni-app 的 `<web-view @message>` 收到 `event.detail.data`。
5. Router 按 `action` 找到服务 handler，执行并得到标准结果。
6. App 使用 `webview.evalJS(...)` 调用 `window.__bridge._onCallback(reqId, result)`。
7. H5 查找 pending，清理超时器并 resolve/reject。

## 3. H5 依赖库公开逻辑

旧依赖库 `src/logics/index.ts` 汇总导出 20 个逻辑：

### 3.1 Bridge 与环境

- `bridge_init`：初始化桥、检测 App 环境、注册全局回调、加载 uni WebView SDK并握手。
- `env_getInfo`：返回当前运行环境信息。
- `env_isApp`：返回是否运行于 App WebView。

### 3.2 扫码

- `scan_start`：开始一次扫码会话，返回扫码成功或错误结果。
- `scan_cancel`：取消当前扫码会话。

### 3.3 蓝牙

- `bluetooth_getState`：获取系统蓝牙与适配器状态。
- `bluetooth_enable`：请求用户打开系统蓝牙。
- `bluetooth_disable`：请求用户关闭系统蓝牙。
- `bluetooth_search`：按超时、名称等条件搜索设备。

### 3.4 电子秤

- `scale_connect`：连接指定电子秤。
- `scale_disconnect`：断开电子秤。
- `scale_status`：查询电子秤状态。
- `scale_readWeight`：发起称重读取并等待结果。

### 3.5 打印机

- `printer_connect`：连接标签打印机。
- `printer_disconnect`：断开打印机。
- `printer_status`：获取打印机状态。
- `printer_cancel`：取消当前打印任务。
- `printer_capture`：把目标 DOM 或内容捕获为打印输入。
- `printer_preview`：将图片传给 App 排版并取得 Base64/Data URL 预览图。
- `printer_print`：将 Base64 图片及打印参数传给 App 执行打印。

### 3.6 返回值与异常约定

业务方法大体返回统一对象：

```ts
{
  status: 'success' | 'error' | 'unsupported',
  code: string,
  message: string,
  data: unknown
}
```

在普通浏览器中，原生业务逻辑通常返回 `status: 'unsupported'`、`code: 'UNSUPPORTED'`。业务错误一般被归一为结构化错误结果，而不是把任意底层异常直接暴露给调用者。`bridge_init` 在 SDK 加载失败等初始化错误上仍可能 reject。

公开逻辑必须继续遵守 LCAP 规范：入口在 `src/logics/index.ts`，文件引入 `@nasl/types`，每个公开函数具备 `@NaslLogic`、标题、描述、参数和返回说明，并使用 `nasl.*` 类型表达平台语义。

## 4. `bridge_init` 与 H5 Bridge Client

### 4.1 核心状态

旧 Bridge 保存：

- 单调递增的 `_reqId`。
- 页面会话 `_sessionId`。
- `Map<number, PendingCall>` pending 请求。
- 输入分片重组状态。
- 已注册事件回调。
- 环境初始化结果。

PendingCall 至少包含 `resolve`、`reject` 和 timeout timer。发送之前先注册 pending，可以避免 App 极快响应时找不到请求。

### 4.2 初始化流程

1. 若 `window.plus` 已存在，直接判定为 App 环境。
2. 否则确保 uni WebView SDK 可用；旧实现支持内嵌地址和公网回退地址。
3. 注册 `window.__bridge._onCallback`、`_onTransfer`、`_onEvent` 等全局入口。
4. 发送 `bridge-ready` 握手。
5. 在约 2 秒等待窗口内收到响应则确认 App 环境，否则按浏览器环境处理。
6. 监听 `pagehide` 和 `beforeunload`，拒绝全部 pending、清理 timer 和未完成分片。

旧实现的初始化结果会缓存。若首次在容器尚未就绪时超时并判断为浏览器，之后晚到的 App 环境无法自动恢复，这是重建时要修正的状态机问题。

### 4.3 请求 envelope

普通请求结构：

```ts
{
  version: 2,
  sessionId: string,
  messageId: string | number,
  action: string,
  reqId: number,
  params: Record<string, unknown>
}
```

旧 App 路由主要校验 payload 是对象、action 存在、params 不是数组。它没有完整校验协议版本和 messageId，也没有请求去重机制。

### 4.4 Promise 完成

App 执行：

```js
window.__bridge._onCallback(reqId, result)
```

H5 收到后：

1. 由 `reqId` 查 pending。
2. 删除 pending。
3. 清 timeout。
4. 根据回调结果 resolve 或 reject。
5. 对未知、重复或迟到 reqId 应忽略或记录诊断信息。

### 4.5 事件

旧 H5 定义 `_onEvent` 与订阅能力，但 App 侧没有完整事件推送实现。其订阅模型还是每种事件一个 handler，缺少：

- 多订阅者。
- subscription token。
- unsubscribe。
- 页面重载后的订阅恢复。
- 事件序号和丢失检测。

新实现不应把旧事件接口视为完整能力。

## 5. uni-app Bridge 与 action 路由

### 5.1 WebView 接收

WebView 的 `@message` 接收 `event.detail.data`。旧实现兼容它是数组或单条对象，然后逐项解析和路由。

### 5.2 action 映射

旧页面集中注册：

- 基础：`bridge-ready`、`ping`。
- 蓝牙：getState、enable、disable、search。
- 扫码：start、cancel。
- 电子秤：connect、disconnect、readWeight。
- 打印：connect、disconnect、status、cancel、preview、print。
- 内部分片：transfer start/chunk/complete/abort/ack。

Router 的职责应保持纯粹：协议校验、action 查找、调用 handler、错误归一化，而不直接承载各领域业务。

### 5.3 App 返回 H5

旧实现获取 H5 WebView 后，通过字符串拼接执行：

```js
webview.evalJS(`window.__bridge._onCallback(${reqId}, ${serializedResult})`)
```

这是 App → H5 返回普通结果的核心。重建时必须：

- 使用安全 JSON 序列化，避免脚本字符串注入。
- 校验当前 WebView URL、origin 和 session。
- 对 WebView 销毁、导航或未就绪显式失败。
- 不再依赖 `children()[0]`，应保存明确 WebView 引用。

旧 `getH5Webview()` 固定取首个 child WebView，多子页面或渲染顺序变化时可能投递到错误页面。

## 6. 各业务领域

### 6.1 `result` 统一结果

负责构造 success/error/unsupported，隔离底层异常格式。新系统应让所有 handler 返回相同 envelope，并区分：

- 协议错误。
- 参数错误。
- 能力不支持。
- 权限拒绝。
- 用户取消。
- 蓝牙状态错误。
- 设备/GATT 错误。
- 业务超时。
- App 或页面关闭导致的取消。

### 6.2 Bluetooth

旧实现包含：

- 获取系统蓝牙状态。
- Android Intent 请求打开/关闭系统蓝牙。
- 搜索设备。
- 名称过滤和 deviceId 去重。
- 同一时刻复用一个搜索 Promise。
- 默认约 5 秒、最短约 1 秒搜索窗口。
- 页面隐藏停止发现，销毁时关闭 adapter。

当前项目已有 `app-ble-manager`，新插件不应重复实现底层 BLE 生命周期，而应把桥 action 映射到其 `ble` API，并由该插件统一管理权限、扫描、连接和 shutdown。

### 6.3 Scan

旧扫码依赖 Honeywell DCS 广播，典型流程：

1. 注册广播接收器。
2. claim scanner。
3. 可选启动软触发。
4. 等待扫描结果、超时或取消。
5. release scanner。
6. 注销 receiver。

它是单会话模型，新请求前先取消旧请求。旧实现指出 Android targetSdk ≥ 34 时，纯 JS 注册 Receiver 无法指定 exported 标志，会直接失败。该能力需要明确原生插件支持或新的兼容实现，不能默认继续有效。

### 6.4 Scale

旧实现：

- 连接 BLE 秤。
- 自动寻找同时具备 write 和 notify 的 GATT service/characteristic。
- 写入 ASCII `R` 触发读取。
- 支持多种称重帧格式，如 A7、A27、XP、YZ、APT、A12+。
- 只允许一个 pending 读请求。
- 超时和断连均会完成 pending，避免悬挂。

风险：自动选择第一个满足 write/notify 的 service 可能选错；经典蓝牙 SPP 秤不能通过这套 BLE GATT 实现。

当前 `app-ble-manager` 已有 `scale` 领域，新桥接管理插件应调用其 `scale.connect/disconnect/getState/readWeight/on/off`。

### 6.5 Printer

旧打印服务使用 LPAPI 单例上下文：

- connect/disconnect 做并发去重。
- preview 和 print 共享 `busy/activeJob` 锁。
- 流程为图片加载、startJob、调整 canvas、startPage、drawImage、commitJob。
- preview 从页面提交回调中取得 Data URL。
- print 等待最终提交结果。

主要约束包括：

- 图片解码后上限约 5 MiB。
- URL 长度上限约 8192。
- 标签宽度不超过约 1000 mm。
- 高度不超过约 5000 mm。
- 打印方向限定为支持集合。
- copies 约束为 1–1000。

当前 `app-ble-manager` 已通过打印适配层接入 `dothan-lpapi-ble`。新插件应映射其 `printer.startDiscovery/stopDiscovery/connect/disconnect/getState/preview/print/on/off`，避免旧服务和新 manager 同时争用 BLE adapter、扫描和连接。

## 7. 双向 Base64 分片机制

### 7.1 使用场景和方向

- `printer_print`：H5 将 Base64 图片发送给 uni-app，属于 **H5 → App 大数据输入**。
- `printer_preview`：uni-app 返回 Base64/Data URL 预览图，属于 **App → H5 大数据输出**。

### 7.2 旧参数

- 直接传输阈值：128 KiB。
- 单片长度：48 KiB。
- 单传输最大值：8 MiB。
- H5 → App 总输入预算：8 MiB。
- 分片生命周期：120 秒。
- H5 → App chunk 失败最多重试 3 次。
- 单片 ACK 等待约 3 秒。

### 7.3 H5 → App

1. H5 判断 Base64 超过直接阈值。
2. 生成 `transferId`。
3. 发送 `__bridge_transfer_start`，声明总长度和片数。
4. 顺序发送 `__bridge_transfer_chunk`，携带 index 和 chunk。
5. 每一片作为独立控制请求等待 App ACK，失败可重试。
6. 发送 `__bridge_transfer_complete`。
7. 原业务参数中的大字符串替换成：

```ts
{
  __bridgeMemoryAttachment: true,
  transferId: string
}
```

8. App 在执行 `printer_print` 前解析 attachment，取得完整 Base64。
9. 失败或取消发送 `__bridge_transfer_abort` 并释放内存。

App 输入侧会检查重复 index。相同内容可幂等确认，不同内容应返回 `BRIDGE_TRANSFER_CORRUPTED`。

### 7.4 App → H5

1. App 得到 preview Data URL。
2. 超过阈值后生成 transferId。
3. App 用 `evalJS` 调用 `_onTransfer({type:'transfer-start', ...})`。
4. App 逐片调用 `_onTransfer({type:'transfer-chunk', index, chunk, ...})`。
5. H5 每片通过普通桥请求发送 `__bridge_transfer_ack`。
6. App 等待 ACK 后继续下一片。
7. 普通业务响应使用 attachment 描述符代替完整 Data URL。
8. H5 在恢复业务响应时按 transferId 取得并拼接全部片段。

### 7.5 旧分片缺陷

- 两个方向协议不对称：H5 → App 明确 complete；App → H5 主要依靠片数和总长度判断完成。
- H5 接收端对“相同 index、不同内容”的重复片可能仍静默 ACK，无法像 App 端一样识别损坏。
- 只校验 Base64 字符和长度，没有 SHA-256 摘要。
- 没有把附件内容类型、业务 action、session 与 transferId 强绑定。
- 缺少严格并发上限、迟到 ACK 和会话切换测试。
- 大字符串拼接可能造成 WebView 内存峰值，8 MiB Base64 加上分片副本和 JSON 转义会显著高于 8 MiB。

### 7.6 新实现要求

统一双向状态机：

`STARTED → RECEIVING → COMPLETED`，任意阶段可进入 `ABORTED/EXPIRED/CORRUPTED`。

统一消息：

- `transfer.start`
- `transfer.chunk`
- `transfer.ack`
- `transfer.complete`
- `transfer.abort`

每次传输应携带：

```ts
{
  protocolVersion: number,
  sessionId: string,
  transferId: string,
  direction: 'h5-to-app' | 'app-to-h5',
  action: string,
  field: string,
  contentType: string,
  totalBytes: number,
  totalChunks: number,
  chunkSize: number,
  sha256: string
}
```

每片校验 index、准确片长、重复内容一致性；完成时校验总长度、片数和摘要。限制单传输大小、会话总预算和最大并发数，并确保成功、失败、超时、页面退出均释放内存。

## 8. 已确认的旧代码问题

### 8.1 `scale_status` 映射断链

H5 公开并发送 `scale_status`，但 App 路由未注册对应 action，旧 scale service 也没有状态查询实现，调用最终得到 `UNSUPPORTED_ACTION`。新项目应建立“公开逻辑清单 ↔ action schema ↔ handler 注册”自动契约测试。

### 8.2 `printer_preview.code` 类型错误

旧 LCAP 声明将 preview 返回的 `code` 写成 `nasl.io.File`，实际运行值是 `'OK'`、`'ERROR_GET_IMAGE_DATA'` 等字符串。新声明必须使用 `nasl.core.String`。

### 8.3 安全边界缺失

旧 WebView 固定加载 HTTPS 页面，但消息入口没有验证：

- 当前 URL/origin。
- host 白名单。
- 导航是否已经离开受信任页面。
- 会话 nonce 或签名。

如果网页发生 XSS、重定向或域名失控，攻击页面可以调用蓝牙、扫码和打印能力。`sessionId` 只能隔离会话，不等同于认证。

### 8.4 其他风险

- WebView 通过 `children()[0]` 获取，可能拿错实例。
- 普通消息不严格校验 version/messageId，且不去重。
- `_onEvent` 没有 App 侧完整实现。
- 初始化浏览器结果永久缓存，容器晚就绪不可恢复。
- `onUnload` 发起异步清理但不等待。
- 文档使用 `initBridge/getEnv/isInApp`，代码使用 `bridge_init/env_getInfo/env_isApp`，已经漂移。
- 打印 preview/print 的大数据流缺少完整端到端故障测试。

## 9. 当前项目从零开发的推荐架构

### 9.1 uni-app 新纯 JS 插件

建议在 `online/src/uni_modules/` 下建立独立插件，例如 `app-capability-bridge`，不要把桥接协议混入 `app-ble-manager`。职责：

- bridge session 生命周期。
- WebView transport。
- 请求、响应、事件和分片协议。
- action registry。
- 参数验证和结果归一化。
- 领域 adapter 注册。
- teardown。

领域 adapter 再调用：

- `app-ble-manager.ble`
- `app-ble-manager.printer`
- `app-ble-manager.scale`
- 后续扫码、文件、升级等能力

这样桥协议与 BLE 生命周期互不污染，并可扩展其他原生能力。

### 9.2 H5 依赖库

建议拆分：

- `logics/bridge.ts`：`bridge_init`、环境和公共调用。
- `logics/bluetooth.ts`
- `logics/printer.ts`
- `logics/scale.ts`
- `logics/scan.ts`
- `bridge/client.ts`
- `bridge/protocol.ts`
- `bridge/transfer.ts`
- `bridge/errors.ts`
- `logics/index.ts`：仅聚合公开逻辑。

LCAP 逻辑只做类型稳定的业务包装，不应直接散落处理 postMessage、pending Map 和分片。

### 9.3 协议设计

握手返回：

```ts
{
  protocolVersion: 1,
  sessionId: string,
  sessionNonce: string,
  capabilities: string[],
  limits: {
    directPayloadBytes: number,
    chunkBytes: number,
    maxTransferBytes: number,
    maxConcurrentTransfers: number
  }
}
```

所有请求和返回同时校验 `protocolVersion/sessionId/messageId/requestId`。需要幂等或去重缓存，避免 WebView 重发造成重复打印等副作用。

事件采用订阅 token：

- `subscribe(eventName)` 返回 subscriptionId。
- App 推送携带 eventSeq。
- `unsubscribe(subscriptionId)` 显式释放。
- 页面销毁清理该 session 所有订阅。

### 9.4 生命周期

- App 壳建立 Bridge 后常驻 `listening`；H5 缺席不触发超时或失败。
- H5 按需 `bridge_init`；退出时单向发送尽力而为的 `disconnect` 并立即 `destroy`，不等待 `disconnect-ack`；再次进入时创建新实例、新 session 并完整 `re-init`。
- App 收到 disconnect、WebView reload/close 或新 session 时执行 session reset，清理旧 session 的 pending、订阅、附件、扫描、扫码和等待资源，但保留打印机、电子秤等 BLE 设备连接，不调用 `lifecycle.shutdown()`。
- App 进入后台时 Bridge 与 session 保持，后台控制消息及执行中的任务继续处理；协议不使用心跳判断 H5 存活。
- App 进程终止后内存状态丢失；冷启动重新建立 `listening`，H5 重新 init，BLE 设备必须由业务重新连接。
- 页面导航或 origin 变化：立即吊销当前 session，完成 session reset 后 App Bridge 继续 listening。

## 10. 测试与验收要求

必须补充：

1. 公开 LCAP API 与 App action registry 的双向契约测试。
2. 请求成功、结构化失败、超时、取消、重复响应、迟到响应测试。
3. 多 pending 并发与 requestId/session 隔离测试。
4. H5 → App、App → H5 双向分片测试。
5. 分片丢失、乱序、重复、重复但内容不同、ACK 丢失、超时、摘要错误和 abort 测试。
6. 多个大附件并发与内存预算测试。
7. 页面刷新、WebView 销毁、App 隐藏/退出后的清理测试。
8. URL/origin 白名单和非受信任页面拒绝测试。
9. 真实 WebView 端到端测试。
10. Android 真机 BLE、电子秤、打印机及扫码设备回归测试。

## 11. 实施前必须保持的结论

- H5 不能直接调用 uni BLE API，必须经过 uni-app bridge。
- `app-ble-manager` 是 BLE 生命周期唯一所有者，新桥插件只做协议和能力编排。
- 普通结果与持续事件必须分开建模。
- Base64 大数据必须走统一、对称、可校验、可取消的分片状态机。
- action、参数和结果必须由共享 schema 或契约测试约束。
- WebView 的 origin 白名单和会话认证属于必要安全边界。
- 打印属于有副作用操作，重试和消息去重必须防止重复打印。
- 任何 App 壳、插件、权限或原生构建链变更，必须同步检查 `Android-APK离线构建PRD.md`。