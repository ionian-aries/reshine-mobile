# Reshine Mobile

Reshine Mobile 是用于承载远程或内置 H5、桥接 Android 原生业务能力，并统一生成 WGT 与 APK 发布物的 uni-app 移动端工程。

## 基本介绍

仓库以 Vue 2 版 uni-app 维护两个宿主：`online` 承载远程 H5 制品，`local` 承载随 APK 发布的本地 H5；两者共用能力桥、蓝牙设备能力和应用更新模块。根目录脚本负责依赖初始化、版本更新、WGT 打包、Docker 构建镜像及 Android APK 离线构建，目标与产物路径由 `build.config.json` 统一配置。

两个子项目都通过 `VUE_APP_UPGRADE_CHECK_URL` 配置独立、完整的更新检查接口 URL，未配置时更新模块不启用检查。
当前 `online` 的通用桥壳候选页和 `local` 的已注册首页均通过 `VUE_APP_WEBVIEW_URL` 指定 WebView 地址；`local` 将其配置为 APK 内的 `/hybrid/html/index.html`。`VUE_APP_LOCAL_API_BASE_URL` 仅供 `local/m` 构建内置 H5 时注入现场后端基址，不是 WebView 地址。

## 文件夹结构设计

- `android-project/`：DCloud Android 离线 SDK 的 Gradle 模板、依赖 AAR、资源与宿主配置，供容器生成 APK。
- `config/`：`online`、`local` 两套 APK 配置、签名输入及允许覆盖的 Android 图标和样式资源。
- `docker/`：容器入口与 Android 工程准备脚本。
- `docs/`：本地 H5、APK、更新系统及桥接能力的设计和接入文档。
- `local/`：本地 H5 宿主；构建脚本将 `local/m` 产物写入 `src/hybrid/html`，当前首页以 `/hybrid/html/index.html` 加载它。
- `online/`：远程 H5 宿主；`index4.vue` 是读取 `.env` 中 WebView 地址的通用桥壳候选页，当前 `pages.json` 注册的首页仍是 `index.vue` 页。
- `output/`：按 `online/local` 和 `wgt/apk` 分类保存构建产物。
- `reshine-uniapp-mobile-bridge-library/`：面向 Vue 2 / LCAP H5 的 TypeScript 桥接依赖库，提供 NASL 逻辑、测试和构建配置。
- `scripts/`：根级初始化、版本、App-plus、WGT、Docker 镜像、APK、本地 H5 资源及诊断服务脚本。

重要一级文件：

- `build.config.json`：构建镜像、HBuilderX 版本、目标目录和产物目录配置。
- `Dockerfile`、`.dockerignore`：Android 离线构建镜像定义及构建上下文过滤规则。

## 根目录脚本

以下清单与根 `package.json` 的 `scripts` 一一对应：

- `npm run init:uniapp`：交互选择并对一个或多个子项目执行 `npm ci`；自动化可追加 `-- --targets online,local`。
- `npm run update:version`：选择单个目标及 patch、minor 或 major，更新其 `src/manifest.json`，同时令 `versionCode` 加一。
- `npm run build:image`：按 `build.config.json` 构建并校验 Linux/amd64 Android 离线构建镜像。
- `npm run build:local-assets`：构建人工准备的 `local/m` H5 源码，完成本地模式适配和校验后写入 `local/src/hybrid/html`。
- `npm run build:wgt`：构建所选目标的 App-plus 资源，并打包、校验 WGT。
- `npm run build:apk`：构建 App-plus 资源并通过隔离的 Docker 容器生成、校验所选目标 APK。

## 使用方案

根目录下的所有script，都可以交互式执行，根据`build.config.json`中配置的项目，来选择执行目标是什么项目

### 安装依赖

```bash
npm ci # 安装依赖
npm run init:uniapp -- --targets online,local # 初始化hbuilderx项目的依赖

```

### 版本更新

```bash
npm run update:version -- --target online
npm run update:version -- --target local
```

命令需要交互选择升级级别并确认，只修改所选目标的 `src/manifest.json`。

### online / local 开发

两个项目都应先从示例创建 `.env`，并配置各自的完整更新检查接口：

```bash
cp online/.env.example online/.env
cp local/.env.example local/.env
```

```dotenv
# online/.env
VUE_APP_WEBVIEW_URL=https://example.invalid/  # 替换为真实的h5端制品地址
VUE_APP_UPGRADE_CHECK_URL=https://upgrade.example.com/api/v1/upgrade/check # 替换为真实的更新检查服务接口

# local/.env
VUE_APP_WEBVIEW_URL=/hybrid/html/index.html # 固定local项目是这个文件路径
VUE_APP_UPGRADE_CHECK_URL=https://upgrade.example.com/api/v1/upgrade/check # 替换为真实的更新检查服务接口
VUE_APP_LOCAL_API_BASE_URL=http://192.168.1.100:8080 # 替换为真实的后端服务基础地址
```

调试，可以通过hbuilderx软件，对online和local项目，执行“运行到手机或模拟器”=>"运行到Android App 基座"

但是，本地模式应先准备并构建资源：

```bash
# 复制好导出的h5端源码后，粘贴到 local/m 目录下，在根目录执行：
npm run build:local-assets -- --target local
```

### WGT

```bash
npm run build:wgt -- --target online
npm run build:wgt -- --target local
```

产物分别位于 `output/online/wgt/<appid>-v<version>.wgt` 和 `output/local/wgt/<appid>-v<version>.wgt`；构建前需完成对应子项目初始化，`local` 还应先生成内置 H5 资源。

### Docker 镜像

```bash
npm run build:image
```

镜像名和固定 HBuilderX 版本来自 `build.config.json`；当前配置镜像为 `android-builder:5.24.2026081301-r1`，平台为 `linux/amd64`。

### APK

```bash
npm run build:apk -- --target online
npm run build:apk -- --target local
```

流程会构建 App-plus、同步目标版本与 Android 输入、挂载 `config/<target>` 并在无网络容器中完成签名构建。产物位于 `output/online/apk/reshine-mobile-online-v<version>.apk` 或 `output/local/apk/reshine-mobile-local-v<version>.apk`；根目录同名 APK 是已有副本，不是脚本的标准输出位置。

## 功能模块

- **H5 宿主**：通过统一桥壳承载远程 `online` 页面或 APK 内置 `local` 页面。
- **能力桥接**：在 H5 与 App-plus 之间提供消息协议、参数校验、生命周期、兼容信封和 RPC 调用。
- **扫码**：支持内部扫描器启动、取消及结果回传。
- **蓝牙**：支持蓝牙状态查询、启停、设备搜索和连接管理。
- **电子秤**：支持蓝牙电子秤连接、断开、状态查询和重量读取。
- **标签打印**：支持打印机连接、状态管理、图片打印及 H5 DOM 截图。
- **大数据传输**：对较大的图片数据执行分片传输、完成确认、终止及 SHA-256 校验。
- **应用更新**：支持更新检查、WGT/APK 更新流程、原生提示层、日志与诊断事件上报。
- **应用信息**：通过桥接读取 App ID、APK 版本和 WGT 版本。
- **发布构建**：统一生成带版本标识的 WGT 和签名 APK。