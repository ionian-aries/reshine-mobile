# app-capability-bridge

纯 JavaScript uni_module，提供 Android App-vue 与受控 H5 的双端 RPC：显式启动/销毁、握手、双向 `register/call/await`、超时、并发乱序、session/generation、严格消息校验，以及安全 `evalJS` transport。通用事件协议通过内部 `bridge.event.subscribe`、`bridge.event.unsubscribe`、`bridge.event.deliver` RPC 实现；两端均可 `subscribe/unsubscribe/emit`，每个订阅独立 `subscriptionId` 和递增 `eventSeq`，会话不匹配的消息被丢弃，destroy 会清空双方订阅。

壳组件在 `mounted` 的下一渲染节拍主动进入与 `load` 共用的有界绑定/启动流程，不再把 `<web-view @load>` 当作唯一入口。mounted、模板 load 与原生 loaded 并发时复用同一 singleflight Promise；首次 load 只作为 supplemental 信号，若 mounted 已成功则不重建，后续真实 load 才按 reload 递增 generation、取消旧任务并重建。原生 WebView 的 `loaded` 事件仅在能力存在时增强监听，destroy/reload 时按原 handler 身份解绑。

HTML `id` 只用于渲染，不再假设它等于 HTML5 Plus `WebviewObject.id`：runtime 从当前 page 的 `children()` 中只保留具备 `evalJS` 的候选，规范化 `getURL()/url/src` 后匹配在线 HTTP(S) 完整 URL或本地 `/hybrid/...` 路径。URL 唯一命中优先；仅剩一个候选时记录 `unique-fallback` 后兼容兜底；多个候选无匹配或多重匹配均明确失败，不取数组首项。默认在 4 秒总预算内每 200ms 重试，destroy/reload 会取消旧重试并以 generation 阻断迟到结果；成功后保存明确原生 WebView 对象并让 `evalJS` 始终投递到该对象。

Bridge Core 建立前，壳只缓存经完整协议校验和安全复制的 H5 `ready`，不缓存业务 request/response；缓冲最多 4 个 session，同 session 更新合并，溢出淘汰最旧候选。Core start 成功后按顺序立即 flush，reload、session 重建和 destroy 清空。ACK 提交记录 `ack.send.start/success/failure`，首个 ACK Promise reject 后保持 connecting，使同 session 后续 ready 可重试；非法入站记录脱敏 `receive.dropped`，仍执行原严格校验。结构化日志还包含 `mounted.start.schedule/start`、`load.supplemental/reload`、`singleflight.reuse`、`bind.start/retry/result`、`ready.buffered/flushed/dropped`、`buffer.flush.start/success`、`bridge.start/success/failure` 与 `evalJS.failure`；候选数量、策略、耗时和标识均脱敏，retry 只在首次及每 5 次记录以避免刷屏。

页面只需声明 `app-capability-bridge-shell` 并传入 `src`；无需 `ref`、`createBridgePage`、`onHide`、`onUnload` 或手动 `destroy`：

```vue
<app-capability-bridge-shell :src="webviewUrl" />
```

壳组件在 `mounted` 自动启动，直接监听当前页面原生 WebView 的 `show/hide/close` 和 App-plus 的 `resume/pause`，在隐藏时取消扫描，在 WebView 关闭或组件 `beforeDestroy` 时幂等销毁桥、传输、订阅和设备任务。Vue 组件本身不会可靠收到 uni-app 页面 `onHide/onUnload`，因此生命周期不依赖页面 hook。`src` 同时接受 HTTP(S) 在线地址与 `/hybrid/html/index.html#/index` 形式的本地资源；本地资源不会被解析或套用网页 origin 规则。

当前真机联调临时关闭 URL/origin allowlist，任意配置页面都可获得桥接能力；生产发布前必须恢复 HTTP(S) 绝对 URL 与精确 origin 校验。壳组件创建隐藏 canvas，并把唯一 `canvasId` 传入打印机连接、预览和打印调用。

内置诊断方法为 `bridge.ping`、`bridge.info`。本阶段注册以下旧 H5 兼容 action：

- 扫码：`scan_start`、`scan_cancel`（Honeywell DCS 广播；单活动会话；软触发可选；成功、超时、取消和异常均幂等 release/unregister；`targetSdkVersion >= 34` 或接收器注册失败返回 `unsupported/SCAN_RECEIVER_UNAVAILABLE`）
- 蓝牙：`bluetooth_getState`、`bluetooth_enable`、`bluetooth_disable`、`bluetooth_search`
- 电子秤：`scale_connect`、`scale_disconnect`、`scale_status`、`scale_readWeight`
- 打印机：`printer_connect`、`printer_disconnect`、`printer_status`、`printer_print`。`printer_preview` 不属于 App Bridge 能力，H5 调用会按普通未注册 action 返回既有 `METHOD_NOT_FOUND` 错误。

业务 action 统一返回 `{status,code,message,data}`。适配层只通过 `app-ble-manager/js_sdk/index.js` 的公开 `ble`、`scale`、`printer` API 调用设备能力。`bluetooth_search` 订阅 `deviceFound`、按设备 ID 去重，并在 timeout 或异常时停止真实 `scanId` 且退订。

当前打印支持 PNG/JPEG/WebP Data URL 或 HTTP(S) URL。完整 RPC 超过 128 KiB 的 Data URL 由桥内部使用 `transfer.start/chunk/complete/abort` 单向传入 App，目标片长 48 KiB，单图解码后上限 5 MiB；包含 SHA-256、有限重试、乱序及一致重复片处理、预算/并发/TTL 和一次性消费。每个 `printer_print` 请求只调用一次 manager `printer.print(job)`；`width`、`height`、`orientation` 原样映射，`copies`、`gapType`、`threshold` 原样映射，`printDarkness`/`printSpeed` 分别映射为 manager 的 `darkness`/`speed`。`operationId` 在当前 session 内去重，缓存 10 分钟、最多 100 条。`printer_preview` 与 `printer_cancel` 均不注册、不导出，也不会以外层特殊 handler 伪造错误或能力。当前平台范围为 Android App-vue。

诊断日志使用 `[ACB:APP][模块]` 前缀；H5 配套库使用 `[ACB:H5][模块]`。只反馈动作、状态、错误码、耗时、大小和脱敏 ID，不记录完整参数/结果、图片 Data URL/分片、扫码正文、rawFrame、token 或完整标识。`bridgeOptions.debugLogging=false` 可关闭 App 详细日志，logger 异常会被隔离。反馈问题时请提供发生时间、日志前缀、动作和错误码。
