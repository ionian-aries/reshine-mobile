# 项目维护规则

## 适用范围

本文件适用于 `reshine-mobile` 目录及其全部子目录。

## 强制同步要求

`Android-APK离线构建PRD.md` 是本项目 online、local 双应用管理及 Android APK Docker 离线构建方案的唯一现行基准文档。

后续任何涉及以下内容的代码、配置、脚本或方案变更，都必须在同一次工作中同步全量检查并更新 `Android-APK离线构建PRD.md`：

- `online/` 或 `local/` 的应用定位、App ID、包名、版本、资源生成方式和发布流程；
- `android-project/` 模板、原生模块、权限、Manifest、AAR/JAR、Gradle 或签名逻辑；
- `config/` 的目录结构、`config.json` 字段、`resources/`、`override/` 或 `secrets/` 约定；
- Docker 镜像、入口脚本、挂载路径、构建命令、离线依赖和输出结构；
- keystore、DCloud App Key、密码、Git 忽略和 Secret 交付规则；
- 构建、发布、验收、安全、错误处理和跨平台要求。

## 更新规则

1. 修改前先阅读完整的 `Android-APK离线构建PRD.md`，确认当前方案和术语。
2. 代码或方案发生变化时，不得只追加临时说明；必须检查全文并修正所有受影响章节、示例、目录树、命令、字段和验收标准。
3. PRD 只保留当前有效的最终结论和实施方案，不记录讨论过程、备选方案、废弃设计、TODO 或 TBD。
4. 代码、配置与 PRD 冲突时，必须在同一次修改中消除冲突，不得保留两套口径。
5. 若变更不影响 PRD，也必须完成影响检查；只有确认不存在架构、接口、流程、安全或验收变化时才可不修改该文档。
6. 新增项目级维护规则时，必须与本文件及 PRD 保持一致。

## 固定基线

- online App ID：`__UNI__EF1708F`。
- local App ID：`__UNI__526C783`。
- HBuilderX Android 模板版本：`5.24.2026081301`，模板保留官方 `simpleDemo` 模块和合法示例配置。
- 容器脚本位于 `docker/`，不属于 `android-project/` 官方工程模板。
- 每个应用使用 `config/<project>` 保存私有 Android 配置和签名材料；`build:apk` 生成一次性 `/input:ro` 快照，并将 `output/<project>/apk` 作为最终输出。
- Docker 镜像版本：`android-builder:5.24.2026081301-r6`。
- `scripts/utils/` 只允许保存至少被两个不同业务脚本直接调用的公共函数；仅供单个脚本使用的逻辑必须留在该脚本中，测试引用不计入复用数量。
- 每个应用的 `.env` 仅用于会编译进前端的公开地址配置；仓库只提交 `.env.example`，真实 `.env` 不提交，也不传入 Docker。
- `config.json` 包含 Android 普通配置及敏感值，不提交 Git；App Key 和签名密码不得迁移到 `.env`。
- keystore 固定保存在 `config/<project>/secrets/`，不提交 Git。
- Docker 构建命令不通过 `-e` 传递 App Key 或签名参数。

## online WebView 与桥接开发背景

- `online/` 是 Vue 2 + Vue CLI 5 的 uni-app 壳工程，App ID 为 `__UNI__EF1708F`。当前仅有启动页 `src/pages/index/index.vue`，页面使用 `<web-view>` 加载 `.env` 的 `VUE_APP_WEBVIEW_URL`；在线业务界面与交互实际运行于该网页，不在 uni-app 页面中实现。
- 本地联调网页为仓库根目录 `demo-vue/`：Vue 2.7 + Vite 3，使用 `npm run dev -- --host 0.0.0.0` 向真机开放服务。Vite 端口会在占用时递增，因此每次启动必须以终端实际 Network URL 更新 `online/.env`，不能假定固定为 5173/5176。
- `demo-vue/index.html` 通过普通 `<script>` 加载 `reshine_uniapp_mobile_bridege_library/dist-theme/index.js`；`src/main.js` 从全局变量 `window.ReshineUniappMobileBridegeLibrary` 取库，并安装 `UtilsLogics` 与 `UseComponents`。全局名由扩展库包名转 PascalCase 生成，包名/构建全局名/网页引用必须同步。
- `demo-vue/src/App.vue` 从 `this.$library.reshine_uniapp_mobile_bridege_library` 读取逻辑。该注入键来自扩展库 `src/index.ts` 的 `LIBRARY_NAME`，两处必须完全一致。当前页面尝试调用 `bridge_init`，但扩展库 `src/logics/index.ts` 尚未导出该函数，因此目前只会得到 `undefined`，桥接功能尚未形成。
- `reshine_uniapp_mobile_bridege_library/` 是 LCAP Vue 2 扩展库。`npm run watch` 执行 `lcap-scripts watch`，持续产出 `dist-theme/index.js`（UMD）和 `index.mjs`、source map、NASL 扩展描述及 API 编译结果，并在动态端口提供目录服务。`demo-vue/index.html` 当前直接写入该次服务地址；watch 服务重启或端口变化后必须同步修改。
- 当前依赖传播链为：扩展库源码变更 → watch 重建 `dist-theme` → demo-vue 重新加载/热更新后使用新全局库 → online WebView 加载 demo-vue → 真机调试页呈现结果。demo-vue 自身变更只影响网页层；online 壳、权限或 uni_modules 变更需要重新编译/运行 app-plus，不能依赖网页热更新。
- `online/src/uni_modules/` 已放入两个尚未接入应用入口和 WebView 通信链路的插件：`app-ble-manager` 与 `dothan-lpapi-ble`。前者是 App 级 BLE（低功耗蓝牙）统一生命周期管理层，导出 `ble`、`printer`、`scale`、`lifecycle`，内部统一权限、系统蓝牙、适配器会话、共享扫描、连接注册、GATT 传输、事件及关闭清理；打印机领域适配后者，电子秤领域独立实现。后者是德佟标签绘制与 BLE 打印 SDK。
- `manifest.json` 和 Android 离线模板已声明互联网、旧版/新版蓝牙及定位兼容权限，且允许明文 HTTP，满足当前局域网开发 URL；权限存在不代表插件已接入。

## 后续改动的影响检查

1. 修改 `demo-vue`：检查网页渲染、Vue 2 兼容性、浏览器控制台，以及通过手机可达的 Network URL 在 online WebView 中的实际表现。
2. 修改扩展库：保持包名、UMD 全局变量、`$library` 注入键和 demo 调用一致；确认 watch 重建成功、demo 重新取得最新脚本，并检查导出 API 的同步/异步和异常约定。
3. 接入 BLE：原生能力必须由 online uni-app 上下文调用，网页不能直接调用 `uni` BLE API；需建立明确的 WebView 双向消息协议、请求 ID、成功/错误响应、异步事件订阅与退订、参数白名单，并在 App 隐藏/退出时调用领域断开和 `lifecycle.shutdown()`。
4. 修改 online 壳、插件、权限、App ID、原生模板或 APK 构建链时，同时按上文规则检查并更新 `Android-APK离线构建PRD.md`；修改纯网页或扩展库且不改变 APK 架构时，也要先完成影响检查。
5. 联调至少同时核对三类进程：扩展库 watch 服务、demo-vue Vite 服务、uni-app app-plus 构建/真机运行；任何动态端口、局域网 IP 或服务停止都会使下游加载失败。
6. 当前缺口：online 的 `handleMessage` 仅向自身 `$emit`，没有命令路由；未发现原生向网页回传的实现；两个 uni_modules 未被 import；扩展库没有实际桥接逻辑或组件；相关链路没有自动化测试。二次开发不得把“文件已存在”误判为“功能已接通”。