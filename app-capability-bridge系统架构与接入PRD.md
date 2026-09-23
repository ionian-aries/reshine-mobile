# app-capability-bridge 系统架构与接入 PRD

> 文档状态：实施基线（最终决策稿）  
> 目标平台：Android uni-app App-vue 宿主与受控在线 H5  
> 目标插件：`app-capability-bridge`（纯 JavaScript `uni_module`）  
> 协议名称：`app-capability-bridge`  
> 协议版本：`1`  
> 更新日期：2026-09-22

## 1. 文档目的

本文定义 H5 与 uni-app 宿主之间的双端对等 RPC、业务能力适配、页面生命周期、安全边界、大图片分片、接入方式、测试和迁移方案。本文是直接实施依据，不再保留架构选型待定项。

本文综合以下事实来源：

- 当前 `app-ble-manager` 能力与旧 H5 契约审查结果；
- 旧版 WebView 双向桥、router、页面和 services 审查结果；
- `uniapp-webview-duplex-rpc-bridge.md` 的双端 RPC 设计；
- `rpc-bridge` 全部源码与测试；
- `rpc/uniapp`、`rpc/vue-project` 的 MVP 页面；
- `online-explore` 页面及 `uni-webview-rpc` 插件原型；
- 旧 H5 `bridge.ts`、uni-app `router.js`、页面及业务 services。

## 2. 背景、问题与事实判断

### 2.1 现状

旧系统已跑通以下链路：

```text
H5 公开逻辑
→ uni.webView.postMessage
→ <web-view @message>
→ action router
→ 原生业务 service
→ childWebview.evalJS
→ H5 Promise 回调
```

旧系统还实现了打印图片 H5→App、预览图片 App→H5 的内存分片，并积累了蓝牙搜索、打印参数、扫码、电子秤及兼容返回结构等业务经验。

当前项目已有 `app-ble-manager`，它是 BLE、打印机和电子秤能力的统一领域入口，也是 BLE 生命周期唯一所有者。打印 SDK Dothan 已被封装在 manager 内部，外层不得直接调用。

### 2.2 旧桥不能原样沿用

旧桥有可复用的业务经验，但协议核心必须重写，原因是：

1. 只以 `action + reqId` 为中心，不是完整的双端对等 RPC；App 主动调用 H5 的能力不完整。
2. 普通消息对协议版本、消息 ID、来源、字段集合和会话的校验不足。
3. 使用 `children()[0]` 查找 H5 WebView，存在多 child 或顺序变化时串台风险。
4. 初始化将浏览器超时结果缓存，容器晚就绪后不能可靠恢复。
5. 没有公开 `bridge_destroy`，页面只靠全局 `pagehide/beforeunload` 做部分清理。
6. 事件只有单 handler，没有订阅 token、取消订阅、序号和会话恢复。
7. `scale_status` 曾存在 H5 已公开、App 未注册的契约断链。
8. `printer_preview.code` 的 NASL 声明与运行值不一致。
9. 双向分片协议不对称，缺少 SHA-256、完整的 complete、会话/业务字段绑定和严格总预算。
10. H5 接收重复分片时没有可靠拒绝“同 index 不同内容”。
11. 大循环逐片处理没有明确异步让出主线程策略，可能影响 WebView 响应。
12. 普通消息和副作用请求没有完备去重，响应丢失场景可能诱发重复打印。
13. 页面导航、BFCache、重复进入退出和 receiver 所有权治理不完整。

### 2.3 `rpc-bridge` 不能原样照搬

`rpc-bridge` 的共享 Core 已实现或验证了许多正确方向：双方 `register/call/await`、请求 ID、并发和乱序、pending 超时、队列、session 替换、generation、防历史会话回滚、严格 JSON 校验、receiver 身份清理、安全 `evalJS` 序列化和幂等 `destroy`。这些应成为新桥核心。

但现有代码和测试仍是基础原型，不是本项目可直接发布的完整实现：

1. **缺少显式 `start()`**：H5 Core 在构造函数内立刻启动 ready 循环，可能早于 receiver、handler 和 SDK 准备完成；构造函数有隐式副作用。
2. **queue 超时墓碑未及时移除**：超时仅删除 pending，queue 中保留失效 ID，直到 flush 才跳过；连接长期未就绪时 queue 长度会被墓碑占满，引发错误的 `QUEUE_OVERFLOW`。
3. **重复请求检查顺序错误**：实现先查 handler，再检查 `inboundActive`；固定要求应为先识别活动重复，再查 handler，避免注册状态变化导致相同活动请求得到不同处理。
4. **安全属性快照不完整**：validator 虽使用 descriptor 校验部分结构，但 `validBase`、响应字段和若干分支仍直接读取外部对象属性；Proxy/getter 可造成多次读取或时序不一致。入站必须一次性安全提取并冻结规范快照后再处理。
5. **receiver 所有权策略不完整**：当前遇到已有 receiver 一律失败，不能识别并安全销毁本库旧实例；也未把 owner token 纳入生命周期。
6. **没有事件协议和业务订阅治理**。
7. **没有双向附件分片、ACK、摘要、预算与 abort**。
8. **没有 origin/导航校验和业务 action schema**。
9. **初始化 ready 缓冲只在外层原型中有限实现，缺少失败重试和完整页面治理**。
10. **App 侧原型仍以“恰好一个 child”为默认解析策略，需要由壳组件保存明确实例并验证归属，不能长期依赖数组位置**。
11. **测试覆盖远少于设计文档列出的竞态与压力矩阵**，尤其缺少分片、导航和 Android 真实 WebView 测试。

### 2.4 MVP 的实际边界

必须准确描述已有 MVP：

- `rpc/uniapp/src/pages/index/index.vue` 启动的是 `local-rpc-server`，WebView 消息只用于发现本地 HTTP RPC 服务；`rpc/vue-project/src/App.vue` 使用 `local-rpc-bridge.js`。这套 MVP **没有接入 `rpc-bridge` Core**。
- `online-explore` 的 `uni-webview-rpc` 是一个 RPC 接入原型，展示了 `createWebViewRpc()`、启动 ready 缓冲、App/H5 echo，但不是目标业务桥。
- 上述 MVP/原型没有实现打印大图片双向分片、preview 临时文件转换、完整 action 兼容、origin 导航安全和业务 schema。
- 资料只明确了 Android 场景或 Android 风格实现，尚无目标 Android 运行矩阵的完整真机证据。

因此不能宣称“现有 MVP 已支持完整 RPC、分片和目标 Android 业务闭环”。

## 3. 最终方案与成功标准

### 3.1 最终技术决策

采用：**吸收 `rpc-bridge` Core 的双端 RPC 与会话状态机思路，修复其已知缺陷；结合旧桥成熟的双向分片经验和旧 H5 业务契约；在新 `app-capability-bridge` 中重新实现。**

明确不采用：

- 不原样复制旧桥；
- 不原样发布现有 `rpc-bridge` MVP；
- 不建立本地 HTTP server 作为主业务通信通道；
- 不让 H5、壳页面或 bridge 直接调用 Dothan；
- 不修改 `app-ble-manager` 来承接桥协议、分片或业务兼容；
- 不要求给 manager 或 Dothan 补自动化测试；
- 不用断开打印机冒充取消打印。

### 3.2 产品目标

1. H5 与 App 双方均可注册方法、主动调用并 `await` 对端异步返回。
2. 100 个双向并发请求乱序完成时无 ID 错配、会话串台和 Promise 重复完成。
3. 页面重复进入、退出、刷新、BFCache 恢复后不存在旧 receiver、timer、pending、订阅或附件泄漏。
4. 旧 H5 能力除 `printer_cancel` 外尽量保持函数签名、参数顺序、返回 envelope 和业务语义。
5. 打印与预览的大图片在目标 Android 真机稳定传输，不阻塞 UI，不因协议重试重复出纸。
6. 非受信任 origin、导航后的页面、非法 action、非法 schema、错误协议版本和旧 session 无法调用原生能力。
7. 页面接入仅需壳组件、URL 和一个生命周期 mixin/工厂，不要求业务页面复制 WebView、canvas、router 与清理代码。

## 4. 范围与非目标

### 4.1 本期范围

- 双端对等 RPC；
- ready 握手、启动缓冲和重试；
- session、generation、防回滚、防串台；
- timeout、queue、pending、并发和乱序；
- 事件订阅与取消；
- 双向稳定分片；
- origin、导航、协议版本、能力白名单和 schema 校验；
- BLE、打印、电子秤、扫码 action adapter；
- 旧 H5 契约兼容；
- Android App-vue transport 与受控在线 H5 真机验收；
- 壳组件、生命周期 mixin/工厂与最小页面接入。

### 4.2 非目标

- 修改 `app-ble-manager` 或 Dothan 的领域实现；
- 为 manager/Dothan 新增测试；
- iOS 支持；未来若纳入，必须独立完成 transport、能力、性能与真机验收设计，不沿用 Android MVP 结论；
- 跨 App 进程、崩溃或页面重建恢复未完成 RPC/transfer；
- Core 自动重试普通业务请求；
- 对所有业务提供 exactly-once；
- 通过 bridge 传输无限流媒体或任意文件；
- 多个 H5 WebView 共享同一个 bridge session；
- 以 bridge session ID 代替用户身份认证；
- 将 `web-view src` 固化在插件中；
- 承诺未经真机矩阵验证的系统版本和 WebView 内核。

## 5. 总体架构

```text
H5 业务页面 / LCAP 公开逻辑
  ├─ 严格业务参数校验（主校验）
  ├─ bridge_init / bridge_destroy
  └─ H5 Client
       ├─ Bridge Core（共享）
       ├─ H5 postMessage Transport
       └─ Transfer / Event Client
                    ⇅ 受控 WebView 通道
uni-app BridgeShell 壳组件
  ├─ <web-view :src="src" @message="...">
  ├─ hidden legacy canvas
  ├─ Bridge Core（共享）
  ├─ uni-app evalJS Transport
  ├─ Session / Origin / Navigation Guard
  ├─ Transfer / Event Service
  └─ Action Registry + Adapters
       ├─ BLE Adapter ─────→ app-ble-manager.ble
       ├─ Printer Adapter ─→ app-ble-manager.printer ─→ Dothan（仅 manager 内部）
       ├─ Scale Adapter ───→ app-ble-manager.scale
       └─ Scan Service ────→ 本插件 services/scan
```

### 5.1 分层责任

- **共享 Bridge Core**：只处理平台无关协议、状态、RPC、事件路由、pending、会话和销毁，不导入 Vue、uni、plus、DOM、manager。
- **Transport**：只负责提交和接收消息；可注入自定义 transport，用于单测、后续平台适配和真机差异隔离。
- **H5 业务逻辑**：主要参数校验、旧公开 API 包装、环境 unsupported。
- **App bridge 边界**：把 WebView 输入视为不可信，再做协议与业务 schema 防御复验。
- **Adapter**：只做 action 到 manager 的调用、字段映射和旧语义编排。
- **Manager**：可信领域层；bridge 不要求它再次验证 WebView 协议。

## 6. `app-capability-bridge` 插件结构

最终目录如下：

```text
online/src/uni_modules/app-capability-bridge/
├── package.json
├── components/
│   └── app-capability-bridge-shell/
│       └── app-capability-bridge-shell.vue
└── js_sdk/
    ├── index.js
    ├── core/
    │   ├── BridgeCore.js
    │   ├── state-machine.js
    │   ├── pending-store.js
    │   ├── event-bus.js
    │   └── transfer-machine.js
    ├── contract/
    │   ├── protocol.js
    │   ├── config.js
    │   ├── errors.js
    │   ├── validation.js
    │   └── action-schemas.js
    ├── transports/
    │   ├── h5-post-message.js
    │   ├── uniapp-evaljs.js
    │   └── memory.js
    ├── services/
    │   ├── scan.js
    │   ├── transfer.js
    │   ├── preview-file.js
    │   └── observability.js
    ├── adapters/
    │   ├── ble.js
    │   ├── printer.js
    │   ├── scale.js
    │   ├── scan.js
    │   └── registry.js
    ├── lifecycle/
    │   ├── h5-owner.js
    │   └── app-session.js
    └── mixins/
        ├── bridge-page.js
        └── create-bridge-page.js
```

约束：

- 插件为纯 JavaScript `uni_module`；不引入原生 Dothan API。
- `adapters/printer.js` 只导入 `app-ble-manager` 的 `printer`。
- `adapters/ble.js`、`adapters/scale.js` 同理。
- 扫码当前不属于 manager，放在本插件 `services/scan.js`，并由 `adapters/scan.js` 暴露 action。
- Android 14 的动态 Receiver exported 限制必须返回准确 unsupported/错误，不伪造扫码成功。

## 7. Bridge Core 公共 API

### 7.1 Core 接口

```ts
interface BridgeTransport {
  start?(receiver: (message: unknown) => void): void | Promise<void>;
  send(message: BridgeMessage): Promise<void>;
  getPeerContext?(): { url?: string; origin?: string; webviewId?: string };
  destroy(): void | Promise<void>;
}

interface CallOptions {
  timeoutMs?: number;
  operationId?: string;
}

interface WaitOptions { timeoutMs?: number }
type Handler = (params: JsonValue, context: Readonly<RequestContext>) => JsonValue | Promise<JsonValue>;
type EventHandler = (payload: JsonValue, context: Readonly<EventContext>) => void;

interface BridgeCore {
  start(): Promise<void>;
  register(method: string, handler: Handler): () => void;
  unregister(method: string): void;
  call(method: string, params?: JsonValue, options?: CallOptions): Promise<JsonValue>;
  subscribe(eventName: string, handler: EventHandler): Promise<() => Promise<void>>;
  publish(eventName: string, payload: JsonValue): Promise<void>;
  receive(message: unknown): void;
  waitUntilReady(options?: WaitOptions): Promise<void>;
  isReady(): boolean;
  getSnapshot(): Readonly<BridgeSnapshot>;
  destroy(reason?: string): Promise<void>;
}
```

### 7.2 显式启动

构造只完成配置校验和内存初始化，不发送 ready、不创建连接 timer。调用顺序固定为：

1. 创建 transport；
2. 创建 Core；
3. 安装 receiver；
4. 注册启动期 handlers/action；
5. 调用 `start()`；
6. H5 开始 ready 重试，App 开始连接等待并消费 ready 缓冲。

`start()` 幂等：并发调用返回同一 Promise；失败后对象进入 `failed`，必须 destroy 后新建，禁止在半初始化实例上复活。

### 7.3 注册与调用

- `register()` 禁止覆盖同名方法，返回幂等注销函数；双方公共实例都暴露相同的 `register/call/waitUntilReady/destroy` 语义，App 可通过壳组件 `call()` 主动调用 H5 已注册方法并 `await`。
- `call()` 在 `idle/starting/connecting` 可进入 queue，在 `ready` 直接发送，在 `failed/destroying/destroyed` 立即拒绝；默认业务 timeout 15 秒，调用方可在 action schema 允许范围内覆盖。
- `call()` 的 timeout 从调用创建时开始，包含排队和握手等待时间；`waitUntilReady()` 仅等待连接，不创建业务 request。
- 发送前必须先登记 pending；`transport.send()` 成功只表示已提交到 WebView 通道，不表示对端收到或执行。
- request 不做 Core 自动重试；超时不代表远端没有执行。
- 打印等副作用 action 另外使用 `operationId` 去重。
- 所有 pending 只通过 `finishPending()` 完成一次。
- 初始硬限制：普通消息 128 KiB、pending 200、queue 100、入站 handler 32；达到上限立即返回对应错误，不静默丢弃或无界等待。

### 7.4 可自定义 Transport

`BridgeCore` 只依赖上述 transport 接口。默认提供：

- H5：`H5PostMessageTransport`，发送走 `window.uni.webView.postMessage({data})`；
- App：`UniAppEvalJSTransport`，发送走已绑定 child WebView 的 `evalJS`；
- 测试：`MemoryTransport`；
- 业务不得直接取得默认 transport 并绕过 Core 发协议消息。

## 8. 协议 Schema

### 8.1 基础 envelope

所有消息首先满足：

```ts
interface MessageBase {
  protocol: 'app-capability-bridge';
  version: 1;
  type:
    | 'ready' | 'ready-ack'
    | 'request' | 'response'
    | 'event'
    | 'transfer.start' | 'transfer.chunk' | 'transfer.ack'
    | 'transfer.complete' | 'transfer.abort';
  sender: 'h5' | 'app';
  sessionId: string;
  generation: number;
  messageId: string;
  sentAt: number;
}
```

规则：

- `protocol/version/type/sender/sessionId/messageId/sentAt` 均必填；业务、响应、事件和 transfer 消息的 `generation` 必须为协商出的正整数，初始 H5 `ready` 固定为 0，由 App 在 `ready-ack` 分配。
- 每种 type 只允许 schema 声明的自有字符串 key；拒绝未知字段、symbol key、getter、setter、自定义 `toJSON`、非普通对象、循环和非有限数。
- Transport 只接受 JSON 字符串或由可信解析器产生的普通数据；App 对 `@message` 的数组/单条差异做边界归一化，但每条消息仍单独校验。禁止把 WebView 传入的活对象直接交给 Core。
- 入站先执行有界遍历：最大深度 16、对象/数组节点总数 10,000、普通消息 UTF-8 上限 128 KiB；超限在任何 handler、附件分配或日志序列化前拒绝。
- 入站先通过属性描述符一次性读取，构造 null-prototype 的规范快照并冻结；后续状态机只读取快照，不重复访问外部对象。
- `messageId` 用于协议去重和诊断；RPC 关联使用 `requestId`。
- ID 优先使用 `crypto.randomUUID()`；fallback 为 role、时间、单调序列和随机数，并做本地冲突检查。

### 8.2 握手

```ts
interface ReadyMessage extends MessageBase {
  type: 'ready';
  sender: 'h5';
  generation: 0;
  capabilitiesRequested: string[];
}

interface ReadyAckMessage extends MessageBase {
  type: 'ready-ack';
  sender: 'app';
  generation: number; // App 分配，必须为正整数
  accepted: boolean;
  capabilities: string[];
  limits: {
    maxMessageUtf8Bytes: 131072;
    chunkChars: 32768;
    maxTransferDecodedBytes: 5242880;
    maxTransferEncodedChars: 6990508;
    maxConcurrentTransfers: 2;
    maxSessionEncodedChars: 8388608;
  };
  error?: { code: string; message: string };
}
```

App 的 `ready-ack` 是唯一能力协商结果。H5 不得仅因存在 `window.plus` 就假定业务 bridge 可用。

### 8.3 RPC 请求与响应

```ts
interface RequestMessage extends MessageBase {
  type: 'request';
  requestId: string;
  method: string;
  params: JsonValue;
  operationId?: string;
}

interface SuccessResponse extends MessageBase {
  type: 'response';
  requestId: string;
  ok: true;
  result: JsonValue;
}

interface ErrorResponse extends MessageBase {
  type: 'response';
  requestId: string;
  ok: false;
  error: {
    code: BridgeRemoteErrorCode;
    message: string;
    data?: JsonValue;
  };
}
```

`method` 必须匹配 `^[A-Za-z][A-Za-z0-9_.-]*$`，区分大小写，不 trim。对旧 action 使用同名 method，如 `printer_print`，避免额外翻译层。

普通 RPC 去重键为 `sessionId:generation:requestId`：执行中的重复请求等待同一执行结果；已完成请求在 2 分钟、最多 500 条的有界缓存内重发同一 response；相同 requestId 但 method/params/operationId 摘要不同则以 `INVALID_MESSAGE` 拒绝。缓存淘汰后重复请求不得重新执行有副作用 action；`printer_print` 仍由独立 `operationId` 缓存保护。响应、事件和 ACK 以 `messageId` 做有界去重，未知或迟到关联 ID 仅限频记录，不改变状态。

### 8.4 事件

事件不是无返回 RPC 的替代品。协议为：

```ts
interface EventMessage extends MessageBase {
  type: 'event';
  subscriptionId: string;
  eventName: string;
  eventSeq: number;
  payload: JsonValue;
}
```

订阅通过内置 RPC：

- `bridge.event.subscribe({eventName}) → {subscriptionId,startSeq}`；
- `bridge.event.unsubscribe({subscriptionId}) → {unsubscribed:true}`。

每个 session 可有多个订阅者。App 只向当前 session 的有效 token 推送；H5 按 `eventSeq` 检测重复和缺口。unsubscribe、session 替换和 destroy 必须调用 manager 的退订函数或扫码清理函数。

### 8.5 分片消息

```ts
interface TransferStart extends MessageBase {
  type: 'transfer.start';
  transferId: string;
  direction: 'h5-to-app' | 'app-to-h5';
  action: 'printer_print' | 'printer_preview';
  field: 'image';
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  encoding: 'base64';
  totalDecodedBytes: number;
  totalEncodedChars: number;
  totalChunks: number;
  chunkChars: number;
  sha256: string;
}

interface TransferChunk extends MessageBase {
  type: 'transfer.chunk';
  transferId: string;
  index: number;
  data: string;
  chunkHash: string;
}

interface TransferAck extends MessageBase {
  type: 'transfer.ack';
  transferId: string;
  ackType: 'start' | 'chunk' | 'complete' | 'abort';
  index?: number;
}

interface TransferComplete extends MessageBase {
  type: 'transfer.complete';
  transferId: string;
}

interface TransferAbort extends MessageBase {
  type: 'transfer.abort';
  transferId: string;
  code: string;
  reason: string;
}
```

业务 request/response 中只放附件描述符：

```ts
{
  __bridgeAttachment: true,
  transferId: string,
  field: 'image',
  sha256: string
}
```

附件必须与 `sessionId + generation + direction + action + field` 全绑定，不能被另一请求或另一会话引用。

## 9. 状态机、会话和防串台

### 9.1 Core 状态

```text
idle → starting → connecting → ready
          ↘ failed       ↘ failed
任意非 destroyed 状态 → destroying → destroyed
```

- `idle`：已构造但未 start；
- `starting`：transport/receiver 准备中；
- `connecting`：等待 ready/ack；
- `ready`：可发送业务消息；
- `failed`：不可恢复终态；
- `destroying/destroyed`：清理中/已释放。

所有迁移通过单一 `transition()`，非法迁移记录错误并拒绝。

### 9.2 Session 与 generation

- H5 与 App 在每个 bridge 实例创建时各生成本端 nonce；H5 `sessionId` 作为会话候选随 ready 发送，App 接受后以 `ready-ack` 回显并赋予该 App 实例单调递增的 `generation`。H5 在收到 ack 前不得自行假定 generation。
- H5 只接受与当前候选 `sessionId` 匹配、来自绑定 App transport 的 ready-ack，之后所有消息必须匹配协商出的 session/generation。
- App 接受首个合法 ready，并把 session 与**明确绑定的 WebView 实例、owner token、受信任 origin**绑定。
- App 保存有界 `seenSessions`；历史 session 的迟到 ready 不得回滚。
- 接受新 session 时递增 `generation`，使旧 flush、handler continuation、event 和 transfer 失效。
- 所有响应使用原请求快照中的 session/generation，不从全局当前值临时读取。
- App 的 `isReady()` 除 `state==='ready'` 外，还要求 `ackPending===false`。
- session 替换时：旧 session 已发送和未发送 pending 均以 `SESSION_REPLACED` 结束；不得把旧 session 创建的业务调用自动搬到新页面。调用方确认幂等后可显式重发，打印必须复用 `operationId` 并先查询状态。

### 9.3 Queue、timeout 与墓碑修复

queue 使用可删除的双索引结构，而不是只保存数组墓碑：

```text
queueOrder: requestId[]
queueEntries: Map<requestId, QueuedRequest>
```

`finishPending()` 在 timeout、send failure、destroy 等所有路径同时删除 `queueEntries`。`queueOrder` 可保留少量惰性 ID，但容量计算只用 `queueEntries.size`；当无效 ID 比例超过 25% 或每次 flush 结束时压缩 `queueOrder`。这样超时请求不会继续占 queue 配额。

### 9.4 入站请求固定顺序

1. 安全快照、协议、字节和 schema 校验；
2. sender、origin、WebView、session、generation 校验；
3. 检查状态是否允许；
4. **先检查 `sessionId:requestId` 是否正在执行或已去重**；
5. 再查 handler；
6. 再检查 inflight 上限；
7. 登记执行 token；
8. 异步执行 handler；
9. finalizer 校验唯一 response；
10. 复核 owner、session、generation 后只提交一次；
11. finally 清理。

打印 `operationId` 的 completed 去重缓存独立于 `inboundActive`，见第 14 节。

## 10. H5 初始化、销毁与 SDK 生命周期

### 10.1 公开生命周期

H5 LCAP 依赖库新增并公开：

```ts
bridge_init(options?): Promise<BridgeState>
bridge_destroy(ownerToken?): Promise<{ destroyed: boolean; remainingOwners: number }>
```

业务能力逻辑在调用前执行 `ensureBridge()`，因此业务方即使漏掉显式 init 也不会直接失败；但页面仍必须显式绑定进入/退出：

- 页面进入：`bridge_init({ ownerToken })`；
- 页面退出：`bridge_destroy(ownerToken)`。

“自动确保初始化”只保证健壮性，不替代显式页面生命周期。

### 10.2 owner token 与引用计数

- 每次页面/应用实例生成稳定 owner token，例如 `routeFullPath + componentUid + mountSeq`。
- 同一 owner 重复 init 幂等，不重复计数。
- 不同 owner 共享同一文档内的 bridge 与 SDK，`owners: Set<string>` 记录所有权。
- destroy 只移除对应 owner；owners 归零后销毁 bridge、receiver、SDK 节点、事件和附件。
- 未带 token 的兼容调用使用固定 `legacy-owner`，仍保持幂等。
- owner 不允许跨 document 恢复；BFCache 恢复生成新 session 和新 bridge 实例。

### 10.3 SDK script 单例加载

文档级 loader 状态：

```text
absent → loading → loaded
          ↘ failed → absent（清理后允许重试）
loaded → disposed（owners 归零或文档结束）
```

实施规则：

1. 优先使用 H5 制品内同版本静态 SDK；不把公网 Raw GitHub 作为默认生产回退。
2. 若 `window.uni.webView.postMessage` 已存在，复用，不重复插 script。
3. loader 保存唯一 Promise、script 节点和 load/error listener。
4. load/error/timeout/abort 由一次性 settle 门控竞争。
5. 失败必须移除 script 节点、listener、timer，清空缓存 Promise，允许下一次完整重试。
6. 成功后记录节点所有权；owners 归零且节点由本库创建时移除节点，但不删除平台已注入的 `window.uni`。
7. SDK ready timeout 与 RPC connect timeout 是两个独立预算。

### 10.4 Ready 缓冲与重试

- H5 receiver 和启动 handlers 必须先安装，再 `start()` 发送 ready。
- H5 每 500ms 重发同一 session 的 ready，直到 ack 或 15s connect timeout；同一 App 页面仅允许一个握手接受流程，`seenSessions` 最多保留 64 条并按 10 分钟 TTL 淘汰。
- App 页面在 Core ready 前只缓冲最多 4 条经 `parseStartupReady()` 完整协议校验与安全复制的 ready，不缓冲 request/response；同 session 重复 ready 合并，超过容量时淘汰最旧候选、保留最新合法候选并记录限频诊断。reload、session 重建和 destroy 必须清空启动缓冲。
- App Core 创建后按顺序投递缓冲。
- ack 同步提交失败时保持 `ackPending`，等待同 session ready 重试；握手成功后的 ack 补发限频且最多 3 次。

### 10.5 页面退出、重复进入与 BFCache

- BFCache：目标 Android System WebView 若触发 `pagehide.persisted/pageshow.persisted`，必须按新 session 重建；未触发时由普通 pagehide/unload 路径覆盖，不把 BFCache 支持作为跨平台假设；
- `pagehide`：销毁当前 bridge；`persisted=true` 时保留页面级生命周期监听器。
- `pageshow.persisted=true`：若没有活动 bridge，以新 session 完整初始化一次。
- `beforeunload`：最终清理。
- `visibilitychange` 不销毁，也不自动重启扫描。
- 同一路由重复 mounted/unmounted 通过 owner token 保证引用准确。
- receiver 属性使用不可枚举、不可写、可配置定义；清理时按函数身份和 owner token 删除。
- 如果 receiver 属于本库旧实例，先完整 destroy 旧实例再安装；无法确认所有权时初始化失败，不覆盖第三方对象。

## 11. uni-app 页面最小侵入方案

### 11.1 方案比较与结论

普通 mixin 能注入 `data/methods/onReady/onUnload`，但**不能给宿主页面注入模板节点**。打印 manager 需要旧版 `<canvas :canvas-id>`，WebView 又必须绑定 `@message`；只用 mixin 仍要求每个页面复制 `<web-view>` 和 hidden canvas，无法保证 canvas、WebView 引用和 bridge 生命周期属于同一组件。

最终采用：

1. **桥接壳组件**封装 `<web-view>`、hidden legacy canvas、transport、adapter 和资源清理；
2. 提供轻量**生命周期 mixin/工厂**，用于页面转发 show/hide/unload 或统一页面选项；
3. 页面只传 `src`、allowed origins 和必要回调。

`web-view src` 始终由页面或环境配置传入，插件不硬编码线上地址。

### 11.2 壳组件接口

```ts
props: {
  src: { type: String, required: true },
  allowedOrigins: { type: Array, required: true },
  canvasId: { type: String, default: '' },
  bridgeOptions: { type: Object, default: () => ({}) }
}

emits: [
  'ready', 'error', 'navigation-blocked', 'state-change'
]

methods: {
  start(), destroy(), call(), publish(), getSnapshot(), handleShow(), handleHide()
}
```

### 11.3 最小接入代码

应用入口显式安装 Vue 2 插件；不要依赖 easycom 隐式扫描，也不要在页面 import 或局部注册组件：

```js
import Vue from 'vue'
import AppCapabilityBridgePlugin from '@/uni_modules/app-capability-bridge'

Vue.use(AppCapabilityBridgePlugin)
```

页面只保留模板和 URL 数据：

```vue
<template>
  <app-capability-bridge-shell :src="webviewUrl" />
</template>

<script>
const webviewUrl = (process.env.VUE_APP_WEBVIEW_URL || '').trim()

export default {
  data: () => ({ webviewUrl })
}
</script>
```

桥壳在 `mounted` 后的下一渲染节拍即主动执行同一套有界 WebView 绑定与 Bridge 启动流程，不再依赖模板 `load` 事件；模板 `load` 和可用时原生 WebView `loaded` 仅作为补充/导航重载信号。mounted/load 并发复用 singleflight，首次迟到 load 不重建已成功 Bridge，后续真实 reload 才销毁旧实例并重建；原生监听在 reload/destroy 时按身份解绑。绑定仍从页面原生 `children()` 中过滤具备 `evalJS` 的候选；不假设模板 HTML `id` 等于 HTML5 Plus `WebviewObject.id`。runtime 规范化候选 `getURL()/url/src` 与配置 `src`：在线地址按规范化 HTTP(S) URL 匹配，本地地址兼容 `file://`、`www/_www` 与 `/hybrid/...` 路径。URL 唯一命中时绑定；只有一个候选时允许记录策略后明确兜底；多候选无唯一命中或多重命中均失败，不取 `[0]`。默认总等待 4 秒、间隔 200ms，重试日志限频；destroy/reload 取消旧重试，generation 阻止迟到完成。绑定成功后保存明确原生对象引用并立即按顺序 flush 最多 4 条合法 ready。模板事件处理器使用 `handleWebViewLoaded`、`handleWebViewMessage`、`handleWebViewError`，避免 `onLoad`、`onError` 等 uni-app 保留生命周期名。页面无需 `ref`、`onShow`、`onHide`、`onUnload` 或手动 `destroy`。

### 11.4 Canvas 封装与 ID 管理

壳组件内部渲染：

```vue
<canvas
  :id="resolvedCanvasId"
  :canvas-id="resolvedCanvasId"
  :style="canvasStyle"
/>
```

规则：

- 必须使用 manager/Dothan 兼容的旧 canvas 接口，不改为 `type="2d"`。
- 默认 ID 为 `acb-print-${pageInstanceId}-${componentSeq}`，只含字母、数字、短横线，避免多壳实例冲突。
- 页面可传固定 `canvasId`，组件需检查本页内未重复；重复则初始化失败。
- 同一个壳实例整个生命周期保持 ID 不变。
- `printer.startDiscovery/connect/preview/print` 均由 printer adapter 注入该 ID。
- adapter 同时注入 `onCanvasResize`，壳组件更新宽高并在下一渲染节拍后 resolve；销毁时完成并清除所有 resize waiter。
- 初始画布采用当前已验证的安全尺寸 960×960，位置移出可视区；销毁时宽高归零并释放等待器。

## 12. Origin、导航与协议安全

### 12.1 Origin 策略

- `allowedOrigins` 必填且只接受精确 `scheme://host[:port]`；生产默认只允许 HTTPS。
- 开发环境 HTTP 需由构建配置显式开启，不允许通配 `*`。
- `file:`、`data:`、`javascript:` 和未知 scheme 默认拒绝。
- URL 中 userinfo、非标准混淆 host、无效端口拒绝。
- bridge start 前校验初始 `src`；每次握手、发送原生 action 前重新校验当前 WebView URL。
- 受控 H5 页面必须配置 CSP、禁止非预期导航并修复 XSS；origin 白名单只能限制站点边界，不能保护已被脚本注入的受信任页面。
- 若 Android WebView/uni-app 运行时无法可靠读取当前 URL 或监听重定向，则生产发布门槛不通过；不得以 H5 自报 URL、消息字段或初始 `src` 代替实时校验。
- 检测到跳转到非白名单 origin 时立即吊销 session、abort transfer、退订事件并拒绝后续能力调用。

H5 `postMessage` 事件本身不能提供可信浏览器 `event.origin` 给 uni-app，因此安全决策以壳组件绑定的 WebView 实例和其当前 URL/导航事件为准，不能只相信消息中的 origin 字段。

### 12.2 能力白名单

App ready-ack 只返回当前构建、平台和策略允许的 action。registry 默认拒绝，未注册 action 返回 `METHOD_NOT_FOUND/UNSUPPORTED_ACTION`。H5 不得通过任意 method 名访问对象属性或动态 import。

### 12.3 双重 schema 校验

- H5 LCAP 逻辑是主校验层：非法参数在建立附件或发送 request 前失败。
- bridge action schema 是防御复验层：假设消息可绕过 H5，独立拒绝非法输入，且不调用 manager mock/真实对象。
- manager 是可信领域层；bridge 不依赖 manager 为 WebView 输入兜底。
- 禁止 `Number(value)` 后再验证；数字字符串、`NaN`、`Infinity`、boolean、数组和对象均按字段规则拒绝。

### 12.4 安全序列化

App `evalJS` 只调用固定 receiver：

```js
window.__APP_CAPABILITY_BRIDGE_RECEIVE__?.(<safe-json>)
```

JSON 必须转义 `<`、U+2028、U+2029；业务 method、ID 和参数只能存在于 JSON，不拼入脚本结构，不通过 `evalJS` 返回值判断送达。

## 13. Action 清单与旧 H5 契约

统一保留业务返回 envelope：

```ts
{
  status: 'success' | 'error' | 'unsupported';
  code: string;
  message: string;
  data: Record<string, unknown>;
}
```

RPC 层错误用于传输/协议失败；已进入 action handler 的业务成功、失败和 unsupported 使用上述 envelope，最大程度兼容旧 H5。

### 13.1 基础与环境

- `bridge_init`：H5 本地公开逻辑，不是普通业务 action；
- `bridge_destroy`：新增 H5 本地公开逻辑；
- `env_getInfo`、`env_isApp`：保留；
- `bridge.ping`：内部诊断；
- `bridge.operation.get`：仅查询当前 session 的打印去重状态和缓存结果；
- `bridge.event.subscribe/unsubscribe`：内部事件管理。

### 13.2 扫码

- `scan_start`：保留，调用本插件 scan service；
- `scan_cancel`：保留，取消当前 session 拥有的扫码；
- 单次扫码会话必须绑定 session/owner；同 session 重复 start 返回 `REQUEST_IN_PROGRESS`，不同 session 不得取消或接收其结果；
- scan service 负责 Android Honeywell DCS 广播的 claim、结果接收、timeout/cancel、release 和 Receiver 注销，并将广播内容限制为预期 action/字段/长度；任何终态只完成一次；
- Android targetSdk ≥34 时若纯 JS 无法以明确 Receiver export flag 安全注册，返回 `unsupported/SCAN_RECEIVER_UNAVAILABLE`，不得降低 targetSdk、绕过平台限制或伪造成功。

### 13.3 蓝牙

- `bluetooth_getState` → `ble.getBluetoothState()`，`systemEnabled` 映射为 `data.enabled`；
- `bluetooth_enable` → `ble.requestEnableSystemBluetooth()`；
- `bluetooth_disable` → `ble.requestDisableSystemBluetooth()`，不传 `force:true`；
- `bluetooth_search` → `ble.on/startScan/stopScan`，bridge 等待窗口、按 deviceId 去重、名称过滤、保存真实 `scanId` 并 finally 退订/停止。

### 13.4 电子秤

- `scale_connect` → `scale.connect(deviceId)`；
- `scale_disconnect` → 先快照后 `scale.disconnect()`，推导 `alreadyDisconnected`；
- `scale_status` → `scale.getState()`，必须在 registry 注册；
- `scale_readWeight` → `scale.readWeight(timeout)`，映射 `overloaded/rawWeight/weightTypeMeaning/rawFrame`；
- `hasStableWeight` 由 bridge 会话缓存维护，在连接、断开和 destroy 时重置；
- 并发读取显式串行或返回兼容 `REQUEST_IN_PROGRESS`，不暴露 manager 内部 Promise 复用细节。

### 13.5 打印机

- `printer_connect` → `printer.getState/disconnect/connect`，同设备 ready 幂等，不同设备先断开；
- `printer_disconnect` → 快照后断开并映射 `alreadyDisconnected`；
- `printer_status` → `printer.getState()`，映射 busy/activeJob/device；
- `printer_preview` → `printer.preview(job)`，临时路径在 bridge App 侧转 Data URL 后分片给 H5；preview 是有资源副作用但不出纸的任务，不自动重试整个 RPC；
- `printer_print` → `printer.print(job)`，H5 大图片先重组和摘要验证；
- `printer_capture`：保留为 H5 本地 DOM 捕获逻辑，不经过 App action；
- `printer_cancel`：**删除候选**。新 bridge 不注册虚假 handler；过渡版本调用时返回 `unsupported/UNSUPPORTED`，不得扩展 manager、直接调用 Dothan或以 disconnect 冒充取消。

### 13.6 打印签名与严格参数

保持旧公开签名和顺序：

```ts
printer_preview(image, width, height, orientation?, threshold?)
printer_print(image, width, height, orientation?, copies?, gapType?, printDarkness?, printSpeed?, threshold?)
```

约束：

- `image`：非空 PNG/JPEG/WebP Data URL 或 HTTP(S) URL；Data URL 解码后不超过 5 MiB；URL 不超过 8192 字符。HTTP(S) URL 仅透传给 manager 既有图片加载链路，bridge 不代为下载；生产是否允许远程图片、允许的 host 与重定向策略必须由构建配置白名单决定，默认仅允许与 H5 同源 HTTPS；
- `width`：有限 number，`0 < width <= 1000`；
- `height`：有限 number，`0 < height <= 5000`；
- `orientation`：严格整数 `0/90/180/270`，省略时 H5 明确补 `0`；
- `copies`：严格整数 `1..1000`；
- `gapType`：严格整数 `0/1/2/3/4/255`；
- `printDarkness`：严格整数 `1..15` 或 `255`；
- `printSpeed`：严格整数 `1..5` 或 `255`；
- `threshold`：严格整数 `0..255`。

adapter 映射：`printDarkness → darkness`、`printSpeed → speed`。`printer_preview.code` 类型修正为字符串。

## 14. 打印与预览稳定分片

### 14.1 固定初始参数

初始发布参数不是 TBD：

- 直接传输阈值：完整 envelope 的 UTF-8 大小不超过 128 KiB；超过即分片；
- 单片目标：32 KiB Base64 字符（`chunkChars=32768`），接收端同时校验字符数和解码后字节数；
- 单附件解码后上限：5 MiB；对应 Base64 内容字符上限按 `4 * ceil(bytes / 3)` 计算，不含 Data URL 头；
- 单 session 所有未释放 transfer 的 Base64 内容预留总预算：8 MiB；同时统计接收分片、重组字符串和摘要工作缓冲，超预算即拒绝；
- 同 session 最大 transfer：2；
- 全局最大 transfer：4；
- start/chunk/complete ACK timeout：3 秒；
- 每阶段最多提交 3 次（首次 + 2 次重试）；
- transfer 总生命周期：120 秒；COMPLETED 未消费附件 TTL 不超过 30 秒；
- 每发送或处理 4 个 chunk，或连续处理达到 8ms 时，执行一次异步 yield；
- ACK 每次提交使用新的 `messageId`，但携带同一 `transferId + ackType + index` 关联键；接收端按关联键幂等完成 waiter。重试的数据帧保留同一业务关联内容，可使用新 messageId，不能仅凭 messageId 判断是否重复执行。

真机压测只允许把参数调得更保守；修改参数必须双端同版本发布并回归。

### 14.2 异步 yield

不得在一个同步循环中切割、hash、拼接全部大字符串。统一：

```js
await new Promise(resolve => setTimeout(resolve, 0))
```

在支持且验证稳定的 H5 可优先使用 `scheduler.yield()`；App-vue 默认使用 `setTimeout(0)`。每 4 片或累计 8ms 让出一次主线程，先到者触发。重组摘要也分段处理，避免连续长任务。

### 14.3 H5→App：`printer_print`/`printer_preview` 输入

1. H5 严格校验全部业务参数；失败时不创建 transfer。
2. 小于阈值的 Data URL 直接放 request；HTTP(S) URL 只作为普通短字符串传给 manager，由既有打印链路加载，禁止由 bridge 任意下载或把网络响应纳入分片。
3. 大图仅接受 Data URL：解析头与 Base64 内容，严格拒绝空白、非法字符和错误 padding，计算解码字节数、总 SHA-256 和各片 hash；分片只承载 Base64 内容，接收端按已验证 MIME 重建 Data URL。
4. 发送 `transfer.start` 并等 ACK。
5. 按 index 顺序发送 chunk；每片等 ACK，超时有限重试。
6. 接收端对重复相同 chunk 幂等 ACK；重复不同内容立即 `CORRUPTED` 并 abort。
7. 发送 `transfer.complete` 并等 ACK。
8. App 校验片数、每片长度、总编码字符、解码字节和 SHA-256。
9. 只有完整通过后，attachment 标记为 `COMPLETED`，并原子绑定到**唯一一个**携带相同 `transferId` 的业务 request；重复消费返回错误，不得再次调用 manager。
10. 业务 request 可在附件完成前到达，但只等待到该 RPC 的剩余 timeout；附件未完成即返回 `ATTACHMENT_NOT_FOUND/TRANSFER_INCOMPLETE`，禁止无限等待。
11. action finally 释放 attachment；错误、timeout、导航、session 替换和 destroy 都 abort。为避免“附件先完成但 request 永不抵达”泄漏，COMPLETED 未消费附件使用不超过 30 秒的独立 TTL。

### 14.4 App→H5：`printer_preview` 输出

1. `printer.preview()` 返回后，bridge 只读取公开结果中的 `dataUrl` 候选；该字段可能实际承载 Data URL、`tempFilePath` 或 `_doc/_downloads/file://` 路径，不扫描任意嵌套对象。
2. 已是 Data URL：校验 MIME、Base64 与大小。
3. App 本地路径执行两阶段验证：输入引用只接受 `_doc/`、策略允许的 `_downloads/` 或本机绝对 `file://`，默认拒绝 `content://`、裸绝对路径、`..` 及多层编码 traversal；随后用 `plus.io.resolveLocalFileSystemURL` 得到 `FileEntry`，再通过 `plus.io.requestFileSystem(PRIVATE_DOC/PUBLIC_DOWNLOADS)` 取得可信根。`entry` 与根都转换为规范化绝对路径后按目录分隔符边界比较，禁止前缀碰撞和越界；不得把用于输入引用的正则再次套在 `entry.fullPath` 上。运行时缺少可信根、路径或 API 时 fail closed。
4. 空路径、不存在、读取失败返回 `ERROR_GET_IMAGE_DATA`；本地路径绝不原样返回 H5。读取前以 `file.size` 执行 5 MiB 上限检查；`FileReader.readAsDataURL` 后严格校验 Data URL 结构、PNG/JPEG/WebP MIME、规范 Base64、解码大小不超过 5 MiB，并以可取得的 magic bytes 核对 MIME。只有已证明处于批准根且文件名/目录可识别为本次临时图片的文件才在 `finally` 删除，否则保留并记录脱敏的安全清理跳过日志。结构化日志只记录 input kind、resolve success、root check、file bytes、read success、mime、data bytes 与 cleanup，不记录完整路径或 Base64。
5. 大于阈值按同一对称状态机发送 start/chunk/complete，并逐阶段 ACK/重试/yield。
6. 普通 RPC response 只携带 attachment 描述符。
7. H5 完成摘要校验与重组后，再把 Data URL 填回旧返回 `data.image` 并完成 Promise。

临时文件转换和分片均在外桥，不修改 manager。

### 14.5 去重与副作用保护

- 所有 transfer 消息按 `messageId` 短期去重。
- 每个 chunk 以 `transferId:index` 去重并校验 hash。
- `printer_print` 必须带 H5 生成的稳定 `operationId`。
- App 保存当前 session 的打印去重记录：`IN_PROGRESS` 时重复请求等待同一结果；`COMPLETED` 时返回缓存结果；`FAILED` 可返回同一失败，不自动重新打印。
- 缓存 TTL 为 10 分钟，最多 100 条，session destroy 时清理。
- RPC timeout 后 H5 不自动重发 print；若业务要重试，必须复用同一 `operationId`。MVP 新增内部诊断 RPC `bridge.operation.get({operationId})`，仅返回当前 session 中该操作的 `IN_PROGRESS/COMPLETED/FAILED/NOT_FOUND` 与已缓存 envelope；它不能启动打印。
- 去重记录只在单个 bridge session 内有效；App 进程崩溃或页面重建后无法证明旧任务是否出纸，H5 必须把结果标记为“未知”并要求人工确认，不能自动重打。

### 14.6 Transfer 状态机

```text
NEW → STARTED → RECEIVING → VERIFYING → COMPLETED → CONSUMED
  └────────────→ ABORTED
各活动状态 ───→ EXPIRED / CORRUPTED / DESTROYED
```

任何终态都释放 chunks、hash 上下文、ACK waiter 和 timer。abort 本身幂等，迟到 ACK/片段只做限频诊断。

## 15. 生命周期与资源治理

### 15.1 App 壳组件

- `created`：建立 owner、安装仅处理 `ready` 的启动缓冲；该入口也必须执行消息大小、schema、当前 WebView 和 origin 校验，不注册业务 handler、不调用 manager；
- `onReady/mounted`：绑定组件所属 WebView、建立 transport、注册 adapter、`start()`；
- `onShow`：只恢复 bridge 诊断，不隐式重开扫描或设备连接；
- `onHide`：停止当前 session 持有的扫描和高耗能订阅，不销毁全局 manager；
- `onUnload/beforeDestroy`：先 `disposed=true`，再 destroy bridge、transfer、事件、scan、页面资源与 WebView 引用。

页面隐藏不等于页面销毁：`onHide` 后连接可以保留，但该 session 不接受新的 H5 能力请求；恢复 `onShow` 时重新核验 WebView URL 和 owner 后才恢复调用。页面真正卸载或导航失信才执行完整 destroy。

单 WebView session 清理与 manager 全局 `lifecycle.shutdown()` 分开：页面销毁只释放 bridge 自己创建的扫描订阅、事件监听、扫码会话、pending、transfer 与 canvas 资源，不主动断开页面开始前已存在或由其他消费者持有的打印机/电子秤连接。BridgeShell **不调用** manager 全局 `lifecycle.shutdown()`；该调用只属于现有 App 根生命周期所有者，避免 bridge 猜测 manager 的全局 owner。

### 15.2 WebView 绑定

- 壳组件保存创建/渲染后确认的明确 child WebView 引用和 ID；HTML 模板 ID 只用于页面节点，不能作为原生 `WebviewObject.id` 相等假设。
- 从页面 `children()` 过滤具备 `evalJS` 的候选，以规范化 URL 匹配在线 HTTP(S) 与本地 `file://`、`www/_www`、`/hybrid/...` 路径；URL 唯一命中优先，仅一个候选可明确兜底，多个候选不可猜测。
- 绑定由 mounted/nextTick 主动开始，使用 3–5 秒有界总预算和适当间隔；模板 `load` 与可用时原生 `loaded` 仅补充同一 singleflight，首次迟到信号不重建，后续真实 reload 才触发重建；destroy/reload 必须取消重试并解绑原生监听，旧 generation 的迟到结果不得创建 bridge。
- transport destroy 后清空引用，任何 send 稳定返回 `BRIDGE_DESTROYED`。

### 15.3 Destroy 固定顺序

1. 幂等设置 `destroying/disposed`，阻止新调用；
2. 吊销 origin/session/generation；
3. 清握手、连接、pending、ACK、transfer timer；
4. 通过 `finishPending()` 拒绝 pending；
5. 清 queue 与墓碑索引；
6. 取消所有事件订阅；
7. abort 所有 transfer，清打印 operation 去重缓存；
8. 停止该 session 拥有的扫描，取消扫码/称重等待；
9. 清 handler 和 inbound token；
10. 销毁 transport，按身份移除 receiver或释放 WebView；
11. 清 canvas resize waiter 和组件引用；
12. 转为 `destroyed`，snapshot 资源计数为 0。

单步失败不得阻止后续清理。已进入 manager 的异步业务不能由 Core 强制取消，但其迟到结果因 generation/owner 不匹配不得发送。

## 16. 错误码

### 16.1 Core/Transport

- `INITIALIZATION_FAILED`
- `SDK_UNAVAILABLE`
- `WEBVIEW_BIND_FAILED`
- `ORIGIN_NOT_ALLOWED`
- `NAVIGATION_REVOKED`
- `PROTOCOL_MISMATCH`
- `INVALID_MESSAGE`
- `MESSAGE_TOO_LARGE`
- `METHOD_NOT_FOUND`
- `TIMEOUT`
- `CONNECT_TIMEOUT`
- `SESSION_ACK_TIMEOUT`
- `SESSION_REPLACED`
- `SESSION_LIMIT_REACHED`
- `SEND_FAILED`
- `QUEUE_OVERFLOW`
- `TOO_MANY_PENDING`
- `BUSY`
- `HANDLER_ERROR`
- `BRIDGE_FAILED`
- `BRIDGE_DESTROYED`

### 16.2 Transfer

- `TRANSFER_REJECTED`
- `TRANSFER_BUSY`
- `TRANSFER_TIMEOUT`
- `TRANSFER_INCOMPLETE`
- `TRANSFER_CORRUPTED`
- `TRANSFER_HASH_MISMATCH`
- `TRANSFER_BUDGET_EXCEEDED`
- `TRANSFER_ABORTED`
- `ATTACHMENT_NOT_FOUND`

### 16.3 业务

沿用旧业务码和 manager 映射，包括参数、权限、蓝牙、连接、称重、扫码、图片和打印错误。bridge 不把任意底层 Error、stack、cause 或平台对象传给 H5。`printer_cancel` 过渡期固定 `status:'unsupported', code:'UNSUPPORTED'`。

## 17. 性能与容量目标

1. 小消息（不含业务处理）bridge 单向提交 P95 ≤ 20ms，双向空 handler RPC P95 ≤ 100ms，以目标真机为准。
2. 100 个并发小 RPC 随机乱序全部正确关联，pending 最终归零。
3. Core 单消息同步校验与路由连续任务目标 ≤ 8ms。
4. 大图处理每 4 片或 8ms yield，交互页面不出现超过 50ms 的 bridge 自身长任务。
5. 默认 pending ≤200、queue ≤100、inflight handler ≤32。
6. 单 session transfer 预留 ≤8 MiB、单附件解码后 ≤5 MiB、并发 transfer ≤2。
7. 连续进入退出页面 200 次，内部计数回到基线，receiver、timer、WebView 和 canvas waiter 无增长。
8. 不记录完整图片、params/result、token 和完整 session ID。

性能目标只在冻结的 Android 真机矩阵验收；不达标时优先减小 chunk 或并发，不放宽安全预算。

## 18. 可观测性

结构化日志字段：

- `bridgeVersion/appVersion/h5Version/platform`；
- role、state、message type、method/action；
- session hash hint、generation、request/operation/transfer ID 的脱敏提示；
- queue/pending/inflight/transfer 数；
- duration、chunk index、重试次数、bytes；
- error code、destroy reason、导航拒绝原因。

指标：

- 初始化成功率、ready 尝试数和耗时；
- RPC 数、成功率、timeout、P50/P95/P99；
- queue/pending/inflight 峰值；
- session 替换、历史 session 拒绝、未知响应；
- transfer 字节、耗时、ACK 重试、hash 失败、abort；
- origin/navigation 拒绝；
- print 去重命中；
- destroy 后资源计数。

日志限频；logger 异常必须隔离。App 壳固定事件包括 `webview.load`、`bind.start/retry/success/timeout`（候选数量、脱敏 ID/URL、匹配策略）、`ready.buffered/flushed/dropped`、`bridge.start/success/failure`、`receive.dropped`、握手 ACK 失败与 `evalJS.failure`。重试只记录首次和固定间隔采样，禁止每轮刷屏。`getSnapshot()` 返回新建冻结对象，不暴露集合、完整 session 或平台引用。

## 19. 测试计划

### 19.1 Core 单元与压力测试

- 双向同步/异步 handler、同时调用、100 并发乱序；
- 10,000 次随机并发、timeout、响应和 destroy 竞态；
- ID 冲突有限重试；
- queue timeout 后立即释放容量，验证墓碑压缩；
- pending 单次完成；
- 重复请求先于 handler lookup 的固定顺序；
- session 替换、历史 ready、防回滚、generation flush；
- ack 丢失、ready 重试、session-ack timeout；
- destroy 后 snapshot 稳定且资源为 0；
- 显式 start 前无发送和 timer 副作用。

### 19.2 安全与 schema 测试

- 两端 action schema 一致；
- H5 校验失败不调用 bridge、不创建附件；
- bridge 绕过 H5 的非法输入不调用 manager mock；
- 数字字符串、NaN、Infinity、getter、Proxy、symbol、toJSON、循环、超深/超大对象；
- 安全属性快照只读一次且不受后续 mutation 影响；
- protocol/version/sender/session/generation/ID/未知字段；
- origin 白名单、重定向、导航后吊销；
- `</script>`、引号、反斜杠、中文、Emoji、U+2028/U+2029。

### 19.3 事件测试

- 多订阅者、token、unsubscribe 幂等；
- eventSeq 重复、乱序和缺口；
- session 替换/页面退出自动退订；
- manager 退订函数只执行一次；
- 销毁后迟到事件不投递。

### 19.4 分片测试

两个方向均覆盖：

- 阈值前后边界、空数据、最大 5 MiB；
- 丢片、乱序、重复相同片、重复冲突片；
- start/chunk/complete ACK 丢失及有限重试；
- chunk hash、总 SHA-256、片长、总长度、片数错误；
- direction/action/field/session/generation 不匹配；
- 预算、并发、总 timeout、abort、导航和 destroy；
- 异步 yield 生效和长任务统计；
- `_doc/_downloads/file://` 成功转 Data URL；路径不存在、读失败、MIME 不匹配；
- `printer_print operationId` 在请求/响应丢失时不重复调用 manager。

### 19.5 Adapter 与兼容测试

- 公开 H5 函数名、参数顺序、NASL 类型和 envelope；
- 全 action 清单与 registry 双向一致；
- `scale_status` 确实注册；
- `printer_preview.code` 为字符串；
- `orientation` 默认明确传 0；
- 蓝牙搜索使用真实 scanId 并 finally 停止/退订；
- 打印字段映射和临时文件转换；
- `printer_cancel` 未注册或稳定 unsupported；
- 只 mock `app-ble-manager` 公共 API，不要求修改或补测 manager/Dothan。

### 19.6 E2E 与 Android 真机

在冻结的 Android App-vue + 受控在线 H5 运行矩阵验收：

- H5→App、App→H5 各 100 条调用；
- 双向各 100 并发随机乱序；
- 首个 ready/ack 人为丢失；
- 慢加载、刷新、前后台、BFCache（若目标 Android System WebView 支持）、连续进入退出 200 次；
- WebView 导航到非白名单页面；
- receiver 缺失、页面关闭、引用失效；
- 大图片 print 与大 preview 双向分片；
- Android BLE 开关、搜索、秤、打印机、扫码；扫码在目标 targetSdk 无安全 Receiver 能力时验收准确 `SCAN_RECEIVER_UNAVAILABLE`；
- 网络离线、H5 资源加载失败、H5 发布版本与 bridge 协议不匹配。

记录设备型号、Android 版本、System WebView 版本、targetSdk、HBuilderX、uni-app、Vue、`uni.webview.js`、App/H5/bridge 版本。至少覆盖一台目标业务设备和一台不同 Android/System WebView 版本设备；具体最低/最高 Android 与 System WebView 范围在首轮兼容性实测后冻结，未进入矩阵的版本不承诺支持。

## 20. 验收标准

### 20.1 功能

- 双端均可 `register/call/await`，事件可订阅和取消；
- 所有 action 按清单工作并保持旧 envelope；
- `printer_cancel` 没有虚假成功；
- 壳组件独立管理 WebView 和 canvas，页面只传 URL/白名单；
- `bridge_init/destroy` 在重复调用、多个 owner、BFCache 下正确。

### 20.2 正确性和安全

- 100 并发乱序无错配；
- session/generation/origin/WebView 任一不匹配时拒绝；
- 所有 Promise 最多完成一次；
- 打印重试不重复出纸；
- H5 主校验与 bridge 防御复验均通过恶意输入用例；
- 外层代码没有 Dothan import。

### 20.3 分片与资源

- 双向 5 MiB 上限内稳定完成并校验摘要；
- ACK 丢失可有限恢复，损坏必失败；
- transfer 超时/abort/destroy 后内存和 timer 归零；
- 页面 200 次进出无持续资源增长；
- bridge 自身无 >50ms 的连续大图处理长任务。

### 20.4 平台

- Android App-vue transport、受控在线 H5 和全部纳入 MVP 的业务能力在冻结真机矩阵全量通过；
- 目标设备缺少扫码安全 Receiver 能力时，仅扫码按明确 unsupported 验收，其余能力仍须通过；
- 构建产物中不存在非目标平台专用 transport、条件分支或验收依赖。

### 20.5 发布门槛

以下条件全部满足才允许灰度：

1. 协议、H5 公开 API、action schema、registry 和旧 envelope 契约测试全部通过，`scale_status` 已注册，`printer_cancel` 仅按约定 unsupported/移除。
2. Core 并发、乱序、timeout、重复、session/generation、destroy 与资源归零测试通过。
3. Android 真实 WebView 能可靠绑定实例、读取当前 URL并在导航失信时吊销；做不到则阻断发布。
4. 5 MiB 双向图片、ACK 丢失、摘要损坏、预算超限、preview 临时文件转换和打印去重真机测试通过。
5. 目标 Android 外设链路通过；扫码不可安全实现时以明确 unsupported 发布并在能力协商中移除 `scan_start/scan_cancel`。
6. 连续进出 200 次无资源增长，性能指标达标，日志不包含图片、敏感参数或完整标识。
7. 灰度开关和旧桥回滚路径演练通过；同一页面不得同时运行新旧桥，不得双写打印。

任一门槛失败均不得以“后续优化”带入生产基线。

## 21. 迁移步骤

1. **冻结契约**：固化旧 H5 公开 API、参数、默认值和 envelope；将 `printer_cancel` 标为删除候选和一版 unsupported 过渡。
2. **实现共享契约**：协议常量、错误码、严格 JSON validator、action schema 和类型声明；逐项锁定旧函数默认值、错误码、data 字段与浏览器 unsupported 语义，形成可执行契约清单。
3. **修复并移植 Core**：增加显式 `start()`、queue 墓碑清理、重复检查顺序、安全属性快照、receiver owner、ready 缓冲/重试。
4. **实现 transport**：H5 postMessage、App evalJS、安全序列化、明确 WebView 所有权；自定义 memory transport 用于测试。
5. **实现 H5 生命周期**：owner/ref count、SDK 单例加载、失败重试、节点清理、BFCache、`bridge_destroy`。
6. **实现壳组件**：封装 WebView、hidden canvas、canvasId、resize waiter、页面生命周期工厂。
7. **接入 adapters**：只调用 `app-ble-manager`；把 scan 放本插件 services；建立 action registry 契约测试。
8. **实现分片和文件转换**：统一双向状态机、ACK/重试/hash/yield/预算/去重/abort；preview 路径转 Data URL。
9. **改造 H5 LCAP 逻辑**：严格主校验、旧签名和 envelope、自动 ensure + 显式 init/destroy、修正声明。
10. **并行灰度**：开发构建可通过配置切换旧桥/新桥，但单页面只允许一个 receiver 和一个业务 bridge；日志对比结果，不做同一打印请求双写。
11. **Android 真机验收**：冻结 Android 设备、系统 WebView、targetSdk 与业务外设运行矩阵，完成全量回归。
12. **切换与清理**：默认启用新桥，稳定一版后删除旧页面内 router/分片/canvas 重复代码及旧 H5 callback 实现。

回滚策略：以构建配置恢复旧桥，仅用于发布回滚；新旧协议不在同一页面同时运行，避免 receiver 和设备资源争用。

## 22. 现有实现的保留与重写清单

### 22.1 保留并迁移

- 旧 H5 公开业务函数名、参数顺序和统一 envelope；
- 蓝牙搜索等待窗口、名称过滤、deviceId 去重和 finally 清理经验；
- 打印尺寸/方向/份数/间隙/浓度/速度/阈值规则；
- 打印和预览共用任务互斥的业务认识；
- preview 本地路径必须转 Data URL；
- 双向分片的直接阈值、逐片 ACK、有限重试和 abort 基本思路；
- `rpc-bridge` 的共享 Core、pending、乱序匹配、session/generation、严格 JSON、安全 evalJS 和 destroy 思路；
- `online-explore` 的薄 `WebViewRpc` 包装与启动 ready 缓冲思路。

### 22.2 必须重写

- 旧 `window.__bridge._onCallback/_onTransfer/_onEvent` 单体全局实现；
- 旧 action router 的宽松消息校验；
- 旧页面内嵌的 WebView、canvas、分片和业务注册大段代码；
- `children()[0]` 的长期绑定方式；
- 单 handler、无 unsubscribe 的事件实现；
- 不对称且无摘要的分片实现；
- 永久缓存 browser timeout 的初始化状态；
- 没有 owner/ref count、显式 destroy 和 BFCache 重建的生命周期；
- `rpc-bridge` 构造时自动握手、queue 墓碑、属性快照、重复检查顺序和 receiver 冲突处理；
- MVP/local HTTP discovery 作为业务主通道的方案。

### 22.3 保持不动

- `app-ble-manager` 领域实现；
- Dothan 实现及其测试状态；
- manager 内 Dothan 封装边界；
- 底层无法提供的真实打印取消能力。

## 23. 最终结论

新系统以一个可显式启动和确定性销毁的共享 Bridge Core 为基础，使用 H5 postMessage transport 与 uni-app evalJS transport，实现双端对等 RPC；在 Core 之上增加严格安全边界、事件和对称分片，在 App 侧通过壳组件封装 WebView 与打印 canvas，并只通过 `app-ble-manager` 使用 BLE、打印和电子秤能力。

该方案既不复制旧桥的协议缺陷，也不把尚未接入业务、没有分片和 Android 完整真机证据的 MVP 当作成品。旧桥保留成熟业务契约与分片经验，`rpc-bridge` 保留 Core 思路并按本文修复。除 `printer_cancel` 删除候选外，旧 H5 逻辑尽量兼容；所有非法参数由 H5 先严格拒绝，再由 bridge 防御复验。测试投入集中在新 Core、transport、adapter、分片和端到端链路，不修改或要求补测 manager/Dothan。