# 当前 uni_modules 能力与旧桥接逻辑契约对照分析

## 1. 目的、范围与已确认结论

本文用于指导 `app-capability-bridge` 和新 H5 LCAP 依赖库的重构：以当前 `app-ble-manager` 的真实运行行为为准，将 BLE、电子秤和打印能力通过稳定的 WebView 双向协议提供给 H5，同时尽量保持旧 H5 公开逻辑的函数名、入参、返回结构和业务语义。

核对范围：

- 当前领域能力：`online/src/uni_modules/app-ble-manager`
- 当前打印 SDK：`online/src/uni_modules/dothan-lpapi-ble`
- 旧 H5 逻辑：`/Users/zhuanghengheng/Works/8.31金川瑞翔-new/reshine-uniapp-mobile-bridege-library/src/logics`
- 旧 uni-app 桥与业务服务：`/Users/zhuanghengheng/Works/8.31金川瑞翔-new/reshine-mobile-online/online/uniapp/src`

本次设计以以下结论为最终约束：

1. `app-ble-manager` 是 BLE、scale、printer 的统一领域能力入口和 BLE 生命周期唯一所有者。
2. `dothan-lpapi-ble` 只允许由 `app-ble-manager` 内部调用；H5、WebView 页面、`app-capability-bridge` 及其他外层模块永不直接导入或调用 Dothan。
3. H5 LCAP 依赖库是主要业务校验层；非法参数必须在真实 bridge 调用前失败，不进入桥、不传到 uni-app。
4. `app-capability-bridge` 是不信任输入的协议边界，必须独立复验协议和参数；其职责是拒绝非法输入，而不是宽松转换、猜测或修复输入。
5. `app-ble-manager` 是可信领域能力层。用户已确认现有插件和导出逻辑可用；能由 H5 或 bridge 编排、映射解决的问题不得下沉修改插件，也不要求给底层插件补自动化测试。
6. `printer_cancel` 当前没有底层能力，后续倾向从 H5 公开逻辑删除；不得扩展 `app-ble-manager` 或 Dothan 来兼容它。
7. 除 `printer_cancel` 的移除候选外，旧 H5 公开函数名、参数、返回 envelope 和业务语义应尽量保持不变，差异由 `app-capability-bridge` 编排和映射。
8. preview 临时文件转 Data URL、H5 → App 与 App → H5 双向分片均由 `app-capability-bridge` 完成，不修改底层插件。
9. 重构必须同步修正 TypeScript 声明与运行字段不一致；新 H5 逻辑、bridge 公共协议类型和 action schema 必须准确，不得复制旧声明错误。

## 2. 分层边界与调用方向

唯一允许的调用方向是：

```text
业务页面
  → H5 LCAP 公开逻辑（主要业务校验）
  → H5 Bridge Client（请求、pending、分片）
  → WebView 协议
  → app-capability-bridge（不信任输入的防御边界、编排、映射）
  → app-ble-manager（可信 BLE/scale/printer 领域能力）
  → dothan-lpapi-ble（仅 app-ble-manager 内部打印适配层可见）
```

### 2.1 H5 LCAP 依赖库

负责：

- 保持公开函数和 NASL 类型稳定。
- 在调用 `invokeApp` 前完成业务参数校验和默认值确定。
- 返回旧接口兼容的统一结果。
- 浏览器环境返回 `unsupported`。
- 管理 H5 侧 pending、超时和 H5 侧分片状态。

不得：

- 将数字字符串、`NaN`、`Infinity` 等值转换后继续调用。
- 直接调用 uni API、`app-ble-manager` 或 Dothan。
- 依赖底层插件替业务输入兜底。

### 2.2 `app-capability-bridge`

负责：

- WebView 会话、origin、协议版本、requestId/messageId 校验。
- action 白名单和参数 schema 复验。
- 请求去重、超时、错误归一化和旧契约返回包装。
- 调用 `app-ble-manager.ble/printer/scale` 并编排语义差异。
- H5 → App 和 App → H5 双向附件分片。
- preview 临时路径读取并转换为 Data URL。
- 页面销毁、导航、会话失效时清理 pending、订阅和附件。

bridge 的校验是安全防线，不是兼容性转换层。例如收到字符串 `"90"` 时应返回参数错误，而不是转换为数字 90。

### 2.3 `app-ble-manager`

负责：

- BLE 权限、系统蓝牙、adapter 会话、扫描和连接注册。
- 打印机发现、连接、状态、预览和打印。
- 电子秤发现、连接、状态和称重。
- 统一 shutdown。

当前命名导出为：

```js
export { ble, printer, scale, lifecycle };
```

默认导出仅为：

```js
{ ble, printer, scale }
```

`lifecycle` 只能通过命名导出取得。

### 2.4 `dothan-lpapi-ble`

Dothan 是 `app-ble-manager` 打印领域内部实现细节。当前 `PrinterService` 已经在内部创建 `LpapiSharedAdapter`，并让 Dothan 复用 manager 的 shared transport。任何外层直接初始化 Dothan 都会绕开统一扫描、连接和生命周期管理，因此属于禁止路径。

## 3. 当前 `app-ble-manager` 公共 API 清单

以下清单同时依据公共 API 包装、领域服务运行代码和 `index.d.ts` 核对。

### 3.1 `ble`

#### `initialize(): Promise<BluetoothState>`

申请权限、注册全局监听并打开 App BLE 会话；并发初始化复用进行中的 Promise。

返回示例：

```js
{
  supported: true,
  permissionGranted: true,
  systemEnabled: true,
  appSessionOpened: true,
  discovering: false,
  connectedDeviceCount: 0
}
```

旧接口的 `enabled` 应映射自 `systemEnabled`，不能映射自 `appSessionOpened`。

#### `getBluetoothState(): Promise<BluetoothState>`

返回上述蓝牙状态，不启动搜索。

#### `requestEnableSystemBluetooth(): Promise<BluetoothState>`

Android App 环境下请求用户开启系统蓝牙并等待最终状态；其他环境可能返回 unsupported 类错误。

#### `requestDisableSystemBluetooth(options?): Promise<BluetoothState>`

```ts
options?: { force?: boolean }
```

存在活动连接且未显式 `force:true` 时会失败。旧 `bluetooth_disable()` 没有 `force` 入参，因此 bridge 必须使用非强制关闭，不能为了兼容而隐式断开设备。

#### `startScan(options?): Promise<ScanHandle>`

```ts
{
  nameContains?: string;
  serviceUUIDs?: string[];
  minRssi?: number;
  timeout?: number;
  allowDuplicatesKey?: boolean;
}
```

返回：

```js
{ scanId: "scan-...", devices: [], discovering: true }
```

该返回值是扫描启动句柄和当前快照，不是等待扫描窗口结束后的最终结果。公共包装只保留上述字段，其他字段会被删除。

#### `stopScan(scanId): Promise<void>`

停止指定扫描订阅；未知 ID 可幂等完成。

#### BLE 事件

```ts
on('stateChanged' | 'scanStateChanged' | 'deviceFound' | 'error', handler): () => void
```

`deviceFound` 实际回调参数为 `(device, metadata)`；公开 `BleDevice` 常见字段包括 `deviceId/name/localName/RSSI/advertisServiceUUIDs/advertisData/lastSeenAt`。

### 3.2 `printer`

#### `startDiscovery(options?): Promise<ScanHandle>`

运行时实际读取：

```ts
{ canvasId?: string; timeout?: number }
```

默认超时 15000ms。打印设备附加 `deviceType:'printer'`。当前声明将其写为通用 `ScanOptions`，没有准确体现 `canvasId`，属于待修正的类型差异。

#### `stopDiscovery(scanId?): Promise<void>`

停止打印机发现。bridge 应保存并使用真实 `scanId`，不要传入自行猜测的 ID。

#### `connect(options): Promise<PrinterBusinessState>`

```ts
{
  deviceId: string;
  name?: string;
  timeout?: number;
  canvasId?: string;
}
```

默认连接超时约 12000ms。连接另一台打印机前需要先断开当前打印机；bridge 可按旧业务语义完成“查状态 → 必要时断开 → 连接”的编排，不修改 manager。

成功状态示例：

```js
{
  state: "ready",
  connected: true,
  ready: true,
  printer: { deviceId: "...", name: "...", deviceType: "printer" },
  printing: false,
  operation: "idle",
  lastError: null
}
```

#### `disconnect(): Promise<{disconnected:boolean; deviceId?:string}>`

没有连接时幂等返回 `{disconnected:true}`。运行中的 preview/print 会先被等待完成；该行为不是 cancel。

#### `getState(): Promise<PrinterBusinessState>`

状态包括 `disconnected/connecting/ready/printing/disconnecting/failed`。运行时还返回 `operation:'idle'|'printing'`。

#### `preview(job): Promise<PrinterPreviewResult>`

无需连接打印机，但与 print 共用单任务锁。返回：

```js
{ dataUrl: "data:image/png;base64,...", result: { statusCode: 0 } }
```

`dataUrl` 字段的运行值也可能是 `_doc/...`、`file://...` 或 `tempFilePath` 提取出的路径。bridge 必须识别路径并读取成 Data URL 后才能回传 H5。

#### `print(job): Promise<...>`

要求打印机 ready。成功示例：

```js
{
  submitted: true,
  result: { statusCode: 0 },
  printer: { deviceId: "...", deviceType: "printer" }
}
```

#### `PrinterPrintJob` 运行字段

```ts
{
  image: string;
  canvasId?: string;
  width?: number;       // 运行默认 80
  height?: number;      // 运行默认 40
  orientation?: number;// 运行默认 90
  copies?: number;      // 默认 1
  gapType?: number;     // 默认 255
  darkness?: number;    // 默认 255
  speed?: number;       // 默认 255
  threshold?: number;   // 默认 128
  jobName?: string;
  onCanvasResize?: Function;
}
```

manager 内部会对多个字段执行 `Number(...)`，且没有完整校验 `orientation`、`gapType` 及 width/height 的有限性。这只是底层当前行为，不是外部契约；H5 和 bridge 都必须严格拒绝非法值。

#### 打印事件

```ts
on('discoveryStateChanged' | 'deviceFound' | 'stateChanged' | 'error', handler): () => void
off(eventName, handler): void
```

### 3.3 `scale`

#### `startDiscovery(options?): Promise<ScaleScanHandle>`

实际只使用 `timeout`，默认 15000ms，并按固定电子秤服务 UUID 搜索。

#### `stopDiscovery(): Promise<void>`

停止当前电子秤发现。

#### `connect(deviceId): Promise<ScaleBusinessState>`

当前只接受固定 GATT profile：

- Service：`49535343-FE7D-4AE5-8FA9-9FAFD205E455`
- Notify：`49535343-1E4D-4BD9-BA61-23C647249616`
- Write：`49535343-8841-43F4-A8D4-ECBE34729BB3`

成功状态示例：

```js
{
  state: "ready",
  connected: true,
  ready: true,
  occupied: false,
  identityVerified: true,
  device: { deviceId: "...", name: "..." },
  serviceId: "...",
  notifyCharacteristicId: "...",
  writeCharacteristicId: "...",
  lastError: null
}
```

#### `disconnect(): Promise<{disconnected:boolean; deviceId?:string}>`

幂等断开。

#### `getState(): Promise<ScaleBusinessState>`

可供 bridge 映射 `scale_status`，无需修改 manager。

#### `readWeight(timeout?): Promise<WeightReading>`

默认约 5000ms，向写特征发送 ASCII `R` 后等待通知。当前读数结构包括：

```js
{
  raw: 12.35,
  rawWeight: "12.35",
  value: 12.35,
  unit: "kg",
  stable: true,
  overloaded: false,
  negative: false,
  sign: "+",
  valid: true,
  weightType: "NT",
  weightTypeMeaning: "net",
  status: "stable",
  rawFrame: "ST,NT,+12.35,kg",
  timestamp: 0,
  receivedAt: 0,
  sequence: 1,
  deviceId: "..."
}
```

超载会 reject `SCALE_OVERLOAD`；并发读取复用进行中的 Promise。这两点与旧语义不同，bridge 应负责兼容映射。

#### 电子秤事件

```ts
on('discoveryStateChanged' | 'deviceFound' | 'stateChanged' |
   'rawFrame' | 'gattDiscovered' | 'probeLog' | 'error', handler): () => void
off(eventName, handler): void
```

### 3.4 `lifecycle.shutdown()`

统一停止扫描、执行打印机和电子秤 cleaner、关闭 BLE adapter、清理监听和连接表。bridge 页面会话清理与 manager 的全局 shutdown 必须区分：单个 WebView 会话结束时先清理该会话资源；只有壳页面或 App 生命周期确实结束时才调用全局 shutdown，避免误伤其他会话。

## 4. TypeScript 声明与运行契约修正

类型不是附属文档，而是新 H5、bridge 和 manager 之间的公共契约。重构时至少处理以下已核实差异：

1. `PrinterBusinessState` 运行时包含 `operation:'idle'|'printing'`，当前声明缺失。
2. `PrinterPrintJob.width/height` 当前声明为必填，运行时却有 80/40 默认值。对外 bridge action 仍应要求旧接口中的 width/height 必填；manager 内部类型则应准确描述其真实可选行为，二者不能混为一个类型。
3. `printer.startDiscovery()` 运行时接受 `canvasId`，当前声明复用 `ScanOptions` 而未包含该字段。
4. `PrinterPreviewResult.dataUrl` 名称不能表达运行时可能返回临时路径。manager 若保持现状，bridge 内部必须用联合语义类型表示“Data URL 或 App 本地路径”，不能仅凭字段名断言已是 Data URL。
5. 旧 `printer_preview` 返回类型把 `code` 错写为 `nasl.io.File`；新 H5 声明必须改为 `nasl.core.String`，运行值仍为 `OK` 或错误码字符串。
6. bridge 的 request、response、transfer、action params/result 应有独立的准确 TypeScript 类型或 schema；禁止用 `any` 掩盖字段漂移。
7. `app-ble-manager` 的声明修正应限定为低风险类型对齐。业务兼容、校验、文件转换和分片不应因此下沉到 manager。

推荐将每个 action 建模为明确映射：

```ts
type ActionContract = {
  printer_print: {
    params: PrinterPrintParams;
    data: Record<string, never>;
  };
  printer_preview: {
    params: PrinterPreviewParams;
    data: { image: string };
  };
  // ...
};
```

由 H5 client、bridge registry 和契约测试共享或生成一致定义，避免“函数已导出但 action 未注册”及字段名漂移。

## 5. 旧 H5 公开契约与能力映射

除 `printer_cancel` 外，统一保持返回 envelope：

```ts
{
  status: 'success' | 'error' | 'unsupported';
  code: string;
  message: string;
  data: object;
}
```

manager 成功时返回领域对象，失败时 reject。bridge 必须捕获并映射为上述 envelope，不能将底层异常直接透传 H5。

### 5.1 映射总表

| H5 公开逻辑 | manager 调用 | bridge 职责 | 结论 |
|---|---|---|---|
| `bluetooth_getState` | `ble.getBluetoothState()` | `systemEnabled → data.enabled` | 保持 |
| `bluetooth_enable` | `ble.requestEnableSystemBluetooth()` | 包装 `{enabled,pending:false}` | 保持 |
| `bluetooth_disable` | `ble.requestDisableSystemBluetooth()` | 非强制关闭；包装结果 | 保持 |
| `bluetooth_search` | `ble.on/startScan/stopScan` | 等待窗口、过滤、去重、字段映射 | 保持，需编排 |
| `scale_connect` | `scale.connect(deviceId)` | 提取 deviceId/serviceId | 保持 |
| `scale_disconnect` | `scale.getState/disconnect` | 推导 alreadyDisconnected | 保持 |
| `scale_status` | `scale.getState()` | 状态映射；bridge 维护稳定读数标记 | 保持 |
| `scale_readWeight` | `scale.readWeight(timeout)` | 字段、超载及并发语义映射 | 保持 |
| `printer_connect` | `printer.getState/disconnect/connect` | 兼容换机语义、设备字段映射 | 保持 |
| `printer_disconnect` | `printer.getState/disconnect` | 推导 alreadyDisconnected | 保持 |
| `printer_status` | `printer.getState()` | busy/activeJob/设备字段映射 | 保持 |
| `printer_preview` | `printer.preview(job)` | 严格复验、临时文件转 Data URL、输出分片 | 保持 |
| `printer_print` | `printer.print(job)` | 严格复验、字段改名、输入分片重组、去重 | 保持 |
| `printer_cancel` | 无 | 不扩展底层 | 移除候选 |

### 5.2 蓝牙

#### `bluetooth_getState()`

旧成功结构：

```js
{ status: "success", code: "OK", message: "", data: { enabled: true } }
```

映射 `BluetoothState.systemEnabled`，不暴露 manager 内部状态字段。

#### `bluetooth_enable()` / `bluetooth_disable()`

旧 data：

```js
{ enabled: true, pending: false }
```

两者都等待系统操作完成后再返回，`pending` 固定 false。关闭蓝牙不得隐式使用 `force:true`；存在活动连接时应返回结构化错误。

#### `bluetooth_search(name?, timeout?, excludeUnnamed=true)`

旧返回设备：

```js
{
  deviceId: "...",
  name: "...",
  rssi: -55,
  localName: "...",
  connected: false,
  paired: false
}
```

bridge 编排：

1. 订阅 `ble.on('deviceFound')`。
2. 调用 `startScan()` 并保存真实 `scanId`。
3. 在约定 timeout 内收集设备。
4. 按 deviceId 去重，按 name/localName 模糊过滤。
5. 根据 `excludeUnnamed` 处理空名称。
6. 在 finally 中停止对应 scanId 并退订。
7. 映射 `RSSI → rssi`。
8. manager 无法可靠提供 paired，兼容字段固定 false；connected 仅在有可靠连接状态时为 true，否则 false。

### 5.3 电子秤

#### `scale_connect(deviceId)`

旧 data：

```js
{ deviceId: "...", serviceId: "..." }
```

从 manager state 的 `device.deviceId` 和 `serviceId` 提取。当前仅支持固定且已验证的 GATT profile，这是能力范围，不应由 bridge 放宽。

#### `scale_disconnect()`

旧 data：

```js
{ disconnected: true, alreadyDisconnected: false, deviceId: "..." }
```

先调用 `getState()` 快照，再调用 `disconnect()`，由前置状态推导 `alreadyDisconnected`。

#### `scale_status()`

旧 data：

```js
{
  connected: true,
  busy: false,
  activeOperation: "",
  deviceId: "...",
  deviceName: "...",
  serviceId: "...",
  hasStableWeight: false
}
```

旧 App 曾漏注册 `scale_status`，但当前 manager 已提供 `getState()`，新 bridge 必须注册并实现该 action。字段映射：

- `connected ← state.connected`
- `busy ← state.occupied || connecting/discovering/disconnecting`
- `activeOperation ← state.state` 的兼容字符串
- `deviceId/deviceName ← state.device`
- `serviceId ← state.serviceId`
- `hasStableWeight` 由 bridge 维护最近一次成功稳定读数标记；连接、断开或会话清理时重置。不得宣称 manager 原生提供该缓存。

#### `scale_readWeight(timeout?)`

旧 data：

```js
{
  overload: false,
  stable: true,
  weight: "12.35",
  unit: "kg",
  weightType: "net",
  raw: "ST,NT,+12.35,kg"
}
```

映射：

- `overloaded → overload`
- 优先使用 `rawWeight` 作为字符串 `weight`
- `weightTypeMeaning → weightType`
- `rawFrame → raw`

为保持旧业务语义，`SCALE_OVERLOAD` 应映射为可识别的超载结果；并发策略由 bridge 显式串行或返回旧式 `REQUEST_IN_PROGRESS`，不能无意暴露 manager 的 Promise 复用语义。

### 5.4 打印机

#### `printer_connect(deviceId)`

旧 data：

```js
{
  printer: {
    deviceId: "...",
    deviceName: "...",
    name: "..."
  }
}
```

bridge 查询当前状态：同设备 ready 时幂等成功；不同设备时先 `printer.disconnect()` 再 `printer.connect({deviceId})`。该兼容编排不需要修改 manager。

#### `printer_disconnect()`

与电子秤相同，先取状态再断开，映射 `{disconnected,alreadyDisconnected,deviceId}`。

#### `printer_status()`

旧 data：

```js
{
  connected: true,
  busy: false,
  activeJob: "",
  deviceId: "...",
  deviceName: "..."
}
```

`busy` 由 `printing`、`operation` 和过渡状态推导；`activeJob` 在 printing 时返回兼容字符串（如 `printing`），空闲时为空字符串。

#### `printer_preview(...)`

旧签名保持：

```ts
printer_preview(
  image: String,
  width: Decimal,
  height: Decimal,
  orientation?: Integer,
  threshold?: Integer
)
```

旧成功结构保持：

```js
{
  status: "success",
  code: "OK",
  message: "",
  data: { image: "data:image/png;base64,..." }
}
```

bridge 调用 `printer.preview({image,width,height,orientation,threshold})`，随后保证 `data.image` 一定是 Data URL；底层返回本地路径时由 bridge 读取转换。

#### `printer_print(...)`

旧签名保持：

```ts
printer_print(
  image: String,
  width: Decimal,
  height: Decimal,
  orientation?: Integer,
  copies?: Integer,
  gapType?: Integer,
  printDarkness?: Integer,
  printSpeed?: Integer,
  threshold?: Integer
)
```

bridge 字段映射：

```js
printer.print({
  image,
  width,
  height,
  orientation,
  copies,
  gapType,
  darkness: printDarkness,
  speed: printSpeed,
  threshold
})
```

旧默认 `orientation=0`，必须由 H5 明确补为 0，并由 bridge 复验后原样传 manager，避免落入 manager 的运行默认 90。其他可选值若旧逻辑定义了默认，也应在 H5 固化；没有旧默认的字段可省略并采用当前 manager 默认，但必须在契约测试中锁定。

旧成功结构继续为：

```js
{ status: "success", code: "OK", message: "打印任务已提交", data: {} }
```

#### `printer_cancel()`

manager 没有 cancel API，也没有可传入 preview/print 的 `AbortSignal`。`disconnect()` 会等待任务结束，不能作为取消替代。

最终处理：

- 将 `printer_cancel` 标记为 H5 公开逻辑移除候选。
- 新 bridge 不注册虚假的成功 handler。
- 不扩展 `app-ble-manager`，不直接调用 Dothan，不以断开连接冒充取消。
- 在正式删除前若需兼容一个版本，应明确返回 `unsupported`，不得返回 `cancelRequested:true`。

## 6. 打印参数严格校验

### 6.1 两层校验原则

H5 是主要业务校验层，必须在调用 `bridge_init/invokeApp` 的真实业务请求前完成校验。bridge 收到请求后再次以同一约束独立复验，因为 WebView 消息属于不可信输入。

两层都采用严格类型判断：

```ts
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStrictInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}
```

禁止先执行 `Number(value)` 再验证。下列输入必须直接失败：

```js
"90"        // 数字字符串
"1"         // 数字字符串
Infinity
-Infinity
NaN
null         // 对必填字段
true
{}
[]
```

### 6.2 约束表

| 字段 | 规则 | 推荐错误码 |
|---|---|---|
| `image` | 非空字符串；PNG/JPEG/WebP Data URL 或 HTTP(S) URL；解码后 ≤ 5 MiB；URL ≤ 8192 字符 | `INVALID_IMAGE` / `IMAGE_TOO_LARGE` |
| `width` | `number`、有限、`>0`、`≤1000` | `INVALID_SIZE` / `PRINT_SIZE_OUT_OF_RANGE` |
| `height` | `number`、有限、`>0`、`≤5000` | 同上 |
| `orientation` | 严格整数，只能是 `0/90/180/270`；省略时 H5 补 0 | `INVALID_ORIENTATION` |
| `copies` | 严格整数 `1..1000` | `INVALID_COPIES` |
| `gapType` | 严格整数，只能是 `0/1/2/3/4/255` | `INVALID_GAP_TYPE` |
| `printDarkness` | 严格整数 `1..15` 或 `255` | `INVALID_PRINT_DARKNESS` |
| `printSpeed` | 严格整数 `1..5` 或 `255` | `INVALID_PRINT_SPEED` |
| `threshold` | 严格整数 `0..255` | `INVALID_THRESHOLD` |

H5 校验失败应直接返回旧 envelope，例如：

```js
{
  status: "error",
  code: "INVALID_ORIENTATION",
  message: "orientation 只能是 0、90、180 或 270",
  data: {}
}
```

此路径不得创建附件、不得发送 `postMessage`、不得调用 uni-app。

bridge 发现非法值时返回协议边界错误 envelope，并记录安全诊断；不得把 `"90"` 变为 `90`，不得把越界值裁剪为默认值，也不得静默删除非法字段。

## 7. 图片、临时文件与双向分片

所有转换和分片均位于 `app-capability-bridge`（包含其 H5 client 与 App 侧实现），底层 manager 和 Dothan 无需修改。

### 7.1 输入图片规范

H5 公开逻辑接受：

- `data:image/png;base64,...`
- `data:image/jpeg;base64,...`
- `data:image/webp;base64,...`
- HTTP/HTTPS URL

公开 H5 逻辑继续按旧契约拒绝裸 Base64。若未来内部 action 支持裸 Base64，必须有明确 `encoding:'base64'` 和 `mimeType`，由 bridge 在完成分片、校验摘要后补成 Data URL；不得靠字符串猜 MIME。

### 7.2 H5 → App 分片

推荐附件元数据：

```ts
{
  protocolVersion: 1;
  sessionId: string;
  transferId: string;
  direction: 'h5-to-app';
  action: 'printer_print' | 'printer_preview';
  field: 'image';
  encoding: 'data-url' | 'base64';
  mimeType: string;
  totalBytes: number;
  totalChunks: number;
  chunkSize: number;
  sha256: string;
}
```

流程：

1. H5 在业务参数校验成功后判断是否超过直接传输阈值。
2. 发送 `transfer.start`。
3. 顺序发送 `transfer.chunk`，每片等待 ACK，有限重试。
4. 发送 `transfer.complete`。
5. App 侧核验片数、长度、重复片一致性和 SHA-256。
6. 仅在完整校验成功后解析 attachment 并调用 manager。
7. 任一步失败、超时或页面退出都发送/执行 abort 并释放内存。

尚未完成重组的片段绝不能传给 `printer.preview/print`。

### 7.3 preview 临时文件转 Data URL

manager 的 `preview().dataUrl` 可能实际是 Data URL 或 App 沙箱路径。bridge 按以下顺序处理：

1. `data:` 开头：校验 MIME、Base64 和大小后直接使用。
2. `_doc/`、`_downloads/`、`file://` 或明确 `tempFilePath`：使用 App 侧文件 API/`plus.io` 读取，转成带正确 MIME 的 Data URL。
3. 空字符串或不存在路径：返回 `ERROR_GET_IMAGE_DATA`。
4. HTTP(S) URL：只有协议明确允许时才下载并转换；否则返回结构化错误，不能把 URL 冒充 Base64。

H5 无法访问 App 沙箱路径，因此路径不得原样放入 `data.image`。

### 7.4 App → H5 分片

转换后的 Data URL 超过阈值时：

1. App 发送 `transfer.start`。
2. App 逐片发送 `transfer.chunk`，H5 对每片 ACK。
3. App 发送 `transfer.complete`。
4. H5 校验总长度、总片数和 SHA-256 后重组。
5. 普通业务响应只携带 attachment 描述符。
6. H5 将附件还原为 `data.image` 后再完成 `printer_preview` Promise。

双向状态机统一为：

```text
STARTED → RECEIVING → COMPLETED
          ↘ ABORTED / EXPIRED / CORRUPTED
```

### 7.5 建议初始限制

- 直接传输阈值：不超过 128 KiB。
- 单片：约 32–48 KiB，以 Android 真机压测为准。
- 图片解码后业务上限：5 MiB。
- 每 session 限制并发 transfer 数和总内存。
- 每片 ACK，有限重试，重复 index 必须校验内容一致。
- transfer 必须绑定 session、direction、action 和 field。
- 打印 messageId 必须去重，避免重试造成重复出纸。
- 页面卸载、导航、会话替换、显式 disconnect、超时和错误路径均必须释放对应 session 的附件；App 进入后台本身不释放附件或重置 session。

## 8. WebView 协议、生命周期与返回规范

### 8.1 最终生命周期

- App Bridge 随 App 壳建立后常驻 `listening`。H5 尚未初始化、已退出或长时间缺席均为正常状态，App 不启动 H5 缺席超时，也不因缺少 H5 进入失败态。
- H5 按需执行 `bridge_init`；退出时单向发送尽力而为的 `disconnect` 并立即 `destroy` 本地状态，不等待 `disconnect-ack`。再次进入时创建新实例、新 session 并完整 `re-init`。
- App 收到 disconnect、WebView reload/close、导航吊销或新 session 后执行 session reset：清该 session 的 pending、queue、订阅、附件、ACK/timer、扫描、扫码和称重等待等会话资源，保留打印机、电子秤等 BLE 设备连接，不调用全局 `lifecycle.shutdown()`。
- App 进入后台时 Bridge 和活动 session 保持；已送达及后台送达的控制消息继续处理，不因 `onHide` 自动拒绝或销毁。协议不设置心跳、租约或离线探测。
- App 进程终止后内存中的 Bridge、session 和 BLE 连接均不可恢复；冷启动重新建立 App Bridge 的 `listening` 状态，H5 重新 init，BLE 设备由业务重新连接。

### 8.2 消息与返回

普通请求至少包含：

```ts
{
  protocolVersion: 1;
  sessionId: string;
  messageId: string;
  requestId: string;
  action: string;
  params: Record<string, unknown>;
}
```

bridge 必须校验：

- 当前 WebView URL 和 origin 白名单。
- session 有效且与当前 WebView 绑定。
- protocolVersion 精确匹配。
- messageId/requestId 格式、唯一性和迟到响应。
- action 在白名单且 handler 已注册。
- params 是普通对象且符合该 action schema。
- 附件属于同一 session/action/field。

普通响应：

```ts
{
  protocolVersion: 1;
  sessionId: string;
  messageId: string;
  requestId: string;
  result: {
    status: 'success' | 'error' | 'unsupported';
    code: string;
    message: string;
    data: Record<string, unknown>;
  }
}
```

App → H5 的 `evalJS` 必须使用安全 JSON 序列化并投递到明确保存的 WebView 引用；不得依赖 `children()[0]`，不得用未经序列化的字符串拼接脚本。

## 9. 风险与处理策略

1. **绕开统一 BLE 生命周期**：通过架构约束禁止外层调用 Dothan；所有 BLE/scale/printer 只走 manager。
2. **打印参数隐式转换**：H5 和 bridge 均严格类型校验，拒绝数字字符串、Infinity、NaN 和非法枚举。
3. **TypeScript 与运行字段漂移**：修正 manager 声明，并为 H5/action/transfer 建立准确公共契约和契约测试。
4. **preview 路径无法供 H5 使用**：bridge 在 App 内读取并转换 Data URL。
5. **重复打印**：messageId 去重，业务成功结果短期缓存；不能因 ACK 或响应丢失重新执行 print。
6. **分片损坏或内存峰值**：摘要、预算、并发限制、逐片 ACK、统一 abort 和清理。
7. **旧 `scale_status` 路由断链**：新 registry 必须注册，使用 `scale.getState()` 映射。
8. **电子秤语义差异**：bridge 映射超载、并发及稳定读数缓存，不修改 manager。
9. **系统蓝牙平台差异**：非 Android App 返回准确 unsupported，不伪造成功。
10. **打印取消缺失**：移除 `printer_cancel` 或过渡期明确 unsupported，不扩展底层。
11. **WebView 被导航或来源失信**：origin 白名单、session 绑定和导航后立即吊销。
12. **全局 shutdown 误伤**：区分单 session 清理和 App 级 manager shutdown。

## 10. 测试与验收范围

用户已确认底层插件无 bug、导出逻辑可用。本次不要求给 `app-ble-manager` 或 `dothan-lpapi-ble` 补自动化测试；测试投入集中在新增和改造边界。

### 10.1 H5 LCAP 逻辑测试

- 除 `printer_cancel` 移除候选外，公开函数名、参数顺序、NASL 类型和返回结构兼容。
- `printer_preview.code` 为字符串类型。
- 打印尺寸、orientation、copies、gapType、浓度、速度、threshold 的合法边界。
- 数字字符串、`NaN`、`Infinity`、布尔值、对象、数组均在调用 bridge 前失败。
- 校验失败不触发 `invokeApp/postMessage`，不创建附件。
- `orientation` 省略时明确传 0。
- 浏览器环境返回 unsupported。

### 10.2 `app-capability-bridge` 单元与契约测试

- H5 API ↔ action schema ↔ handler registry ↔ response data 双向契约一致。
- 所有 action 的 success/error/unsupported envelope。
- bridge 对恶意或绕过 H5 的非法参数再次拒绝，且不执行 manager mock。
- manager 错误码到旧 H5 错误 envelope 的映射。
- 蓝牙扫描等待、过滤、去重、真实 scanId 停止、退订和 finally 清理。
- connect/disconnect/status 的前置状态快照和字段映射。
- scale 超载、并发策略、稳定读数标记重置。
- printer 字段改名和默认值，尤其 orientation=0。
- `printer_cancel` 未注册或过渡期稳定返回 unsupported。
- TypeScript 类型测试覆盖运行字段和 action params/result。

### 10.3 WebView 协议测试

- protocolVersion/sessionId/messageId/requestId 校验。
- action 白名单、普通对象 params 和 schema 校验。
- origin 白名单、导航后 session 吊销、错误 WebView 拒绝。
- 重复请求、重复响应、迟到响应和打印去重。
- pending 超时、页面刷新/销毁和 App 生命周期清理。
- 安全 JSON 序列化及特殊字符回传。

### 10.4 分片与文件转换测试

两个方向均覆盖：

- 直接阈值上下边界。
- 丢片、乱序、重复相同片、重复冲突片。
- ACK 丢失、有限重试、complete 缺失、超时和 abort。
- totalBytes/totalChunks/chunkSize/SHA-256 错误。
- session/action/field 不匹配。
- 并发附件数、总内存预算和清理。
- Data URL、HTTP(S)、非法 URL、空 Base64、超限图片。
- `_doc/`、`_downloads/`、`file://`、`tempFilePath` 转 Data URL。
- 路径不存在、读取失败、MIME 不匹配和空 preview。

### 10.5 端到端集成测试

- H5 → WebView → bridge → manager mock/真机 → 返回完整闭环。
- Android 真机蓝牙开关与扫描。
- 打印机连接、状态、preview、print 和防重复打印。
- preview 临时路径转 Data URL 后的 App → H5 大结果分片。
- H5 → App 大图片分片后打印。
- 电子秤连接、状态、称重、超载和断连恢复。
- 页面卸载、重新进入、WebView 导航和 App 退出清理。

验收不以“给底层补测试”为前置条件；真机测试验证的是新 H5、bridge、WebView 协议、映射和完整集成链路。

## 11. 实施顺序

1. 冻结旧 H5 API 清单，确认 `printer_cancel` 的移除版本和过渡策略。
2. 定义 action、返回 envelope、错误码和 transfer 的准确 TypeScript/schema 契约。
3. 修正旧 H5 声明错误和严格校验，确保非法打印参数在 bridge 前终止。
4. 实现 bridge 会话、安全边界、registry、去重和错误包装。
5. 仅通过 `app-ble-manager` 实现 BLE/scale/printer adapter 与旧语义映射。
6. 在 bridge 中实现 preview 路径转 Data URL 和双向统一分片。
7. 完成 H5、bridge、WebView 协议、映射和端到端测试。
8. 仅当外层无法实现且有新的明确业务需求时，才单独评估 manager 变更；当前事项均不要求修改 Dothan，除低风险声明对齐外应尽量不改 manager。

## 12. 最终结论

当前 `app-ble-manager` 已能统一提供目标 BLE、电子秤和打印能力，重构重点不是改造底层，而是建立准确、严格、可测试的 H5 与 WebView 适配层：H5 先完成业务校验，bridge 再作为不信任输入边界复验并承担协议、映射、文件转换和分片，manager 保持可信领域能力层，Dothan 始终封闭在 manager 内部。

除不受支持且拟删除的 `printer_cancel` 外，旧 H5 业务接口可以通过 bridge 编排基本保持兼容。打印参数必须拒绝隐式数字转换和非有限值；preview 本地路径转换、双向大数据分片、请求去重以及 TypeScript 契约对齐，均是新 bridge 与 H5 重构的核心验收项。