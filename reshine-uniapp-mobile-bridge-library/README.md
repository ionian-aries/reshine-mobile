# uniapp 移动端桥接库

提供 LCAP/NASL 公开逻辑及 H5 RPC Bridge。`printer_capture(refName)` 是纯 H5 DOM 截图能力，返回 `{ image, mimeType, pixelWidth, pixelHeight, byteLength }`，不调用 App Bridge；截图等待图片、字体和布局稳定，使用 snapDOM `scale: 1`，并维持 5 MiB 上限。

`printer_print(image, width?, height?, orientation?, copies?, gapType?, printDarkness?, printSpeed?, threshold?)` 的运行时默认值为 `width=80`、`height=40`、`orientation=90`、`threshold=180`；方向允许 `0/90/180/270`。`printer_preview(image, width, height)` 公开接口仅保留三个参数，发送到 App 的 RPC 载荷也不包含方向和阈值；App 侧仍兼容历史字段。

## 大图片附件

`printer_print`、`printer_preview` 接受 PNG/JPEG/WebP Data URL 或 HTTP(S) URL。超过 128 KiB 的 Data URL 在内部通过 `transfer.start/chunk/complete/abort` 分片，不暴露给 NASL 调用方；目标片长 48 KiB，单图解码后最大 5 MiB。双端执行 SHA-256、有限重试、超时、预算、并发、TTL、重复片一致性和一次性消费校验。缺少 WebCrypto 时使用库内 SHA-256 兼容实现。

预览大图在 H5 重组后仍以旧字段 `data.image: string` 返回。App 返回的沙箱临时路径由 App Bridge 转为 Data URL，H5 不接收本地路径。打印 RPC 使用内部稳定 `operationId`，超时后不会自动重新执行整个打印。

## 开发与验证

```bash
npm install
npm run test:run
npm run typecheck
npm run build
```

库的 LCAP 身份为历史名称 `reshine-uniapp-mobile-bridege-library`（保留 `bridege` 错拼），当前版本为 `0.0.38`。构建会生成 `dist-theme`、编译公开 API，并执行 npm pack 验证。
