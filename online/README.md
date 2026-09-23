# online

启动页直接把 `.env` 的 `VUE_APP_WEBVIEW_URL` 交给桥壳。应用入口通过 `Vue.use(AppCapabilityBridgePlugin)` 全局注册组件，因此页面不需要 import 或 `components` 配置：

```vue
<app-capability-bridge-shell :src="webviewUrl" />
```

桥壳会自动启动，并监听页面 WebView 与 App-plus 的显示、隐藏和关闭事件；页面无需 `ref`、`onHide`、`onUnload` 或手动销毁。当前调试阶段未限制 URL/origin，生产发布前必须恢复 HTTP(S) 地址校验和精确来源白名单。

```bash
npm install
npm run test:bridge
npm run build:app-plus
```