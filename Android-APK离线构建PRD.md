# Reshine Mobile 双应用 Android APK 离线构建产品需求文档

## 1. 目标与边界

本文是 `reshine-mobile` 的现行实现基准。项目包含两个 UniApp：

| 目标 | 目录 | App ID | 页面来源 |
| --- | --- | --- | --- |
| online | `online/` | `__UNI__EF1708F` | `<web-view>` 加载 `VUE_APP_WEBVIEW_URL` |
| local | `local/` | `__UNI__526C783` | `<web-view>` 加载 APK 内 `hybrid/html/index.html` |

local 只离线携带网页静态资源。认证、数据增删改查、上传、对象存储、服务端二维码等仍访问 `VUE_APP_LOCAL_API_BASE_URL` 指定的现场局域网后端；扫码、蓝牙、电子秤和打印依赖 UniApp/HTML5 Plus 原生桥及 Android 权限。

Android Docker 镜像只把已生成的 App-plus 资源封装成 APK，不安装前端依赖、不构建 H5、不构建 UniApp 源码。

## 2. 配置分层

### 2.1 `build.config.json`

根配置只描述能力和路径：

```json
{
  "apk": { "image": "android-builder:5.24.2026081301-r6" },
  "targets": {
    "online": {
      "uniapp": { "dir": "online" },
      "apk": { "inputDir": "config/online" },
      "output": { "wgtDir": "output/online/wgt", "apkDir": "output/online/apk" }
    },
    "local": {
      "uniapp": { "dir": "local" },
      "localAssets": {
        "sourceDir": "local/m",
        "outputDir": "local/src/hybrid/html"
      },
      "apk": { "inputDir": "config/local" },
      "output": { "wgtDir": "output/local/wgt", "apkDir": "output/local/apk" }
    }
  }
}
```

只有配置了 `localAssets` 的目标会进入 `build:local-assets` 选择列表。显式传入不具备该能力的目标必须失败。

### 2.2 前端环境配置

- `online/.env`：`VUE_APP_WEBVIEW_URL`，必须是 HTTP(S) 绝对地址。
- `local/.env`：`VUE_APP_LOCAL_API_BASE_URL`，必须是无凭据、查询参数和片段的 HTTP(S) 绝对地址。
- 仓库只提交 `.env.example`，真实 `.env` 不提交。
- 这些值会编译进前端，不能保存 Token、DCloud App Key、签名密码等 Secret。

### 2.3 Android 私有配置

`config/<target>/config.json` 和 `config/<target>/secrets/` 不提交 Git。配置结构如下：

```json
{
  "template": { "hbuilderxVersion": "5.24.2026081301" },
  "uniapp": {
    "name": "reshine-mobile-online",
    "appid": "__UNI__EF1708F",
    "versionName": "1.0.0",
    "versionCode": 100
  },
  "android": {
    "namespace": "com.jinchuan.reshine_mobile_online",
    "applicationId": "com.jinchuan.reshine_mobile_online",
    "appName": "金川瑞翔在线版",
    "dcloudAppKey": "实际 App Key",
    "signing": {
      "storeFile": "secrets/release.keystore",
      "storePassword": "实际密码",
      "keyAlias": "实际别名",
      "keyPassword": "实际密码"
    }
  }
}
```

Gradle 使用 `storeFile`、`storePassword`、`keyAlias` 和 `keyPassword` 完成 release 签名；容器随后使用 `apksigner verify` 确认 APK 签名结构有效。无需额外维护证书指纹副本。

## 3. 目录规范

```text
reshine-mobile/
├── online/                        # online UniApp
├── local/
│   ├── m/                         # 人工复制的 H5 源码，不提交
│   └── src/hybrid/html/           # 构建生成的 H5 制品，不提交
├── android-project/simpleDemo/    # HBuilderX 5.24.2026081301 原生模板
├── docker/                        # APK 容器脚本
├── scripts/                       # 宿主编排脚本
├── config/<target>/
│   ├── config.json                # 私有
│   ├── override/                  # 可选白名单资源覆盖
│   └── secrets/                   # 私有签名材料
└── output/<target>/{wgt,apk}/     # 发布产物
```

旧的 `config/<target>/resources/apps` 不参与构建，并由 Git 忽略。每次 APK 构建都从本次 App-plus 输出生成一次性输入快照。

## 4. local H5 构建

执行：

```bash
npm run build:local-assets
npm run build:local-assets -- --target local
```

流程：

1. 开发人员人工复制 H5 源码到 `local/m`。脚本不读取任何仓库外目录。
2. 脚本校验源码、输出路径、符号链接和特殊文件。
3. 删除 `local/m/dist` 和 `local/src/hybrid/html` 旧输出。
4. 在 `local/m` 执行 `npm install --no-audit --no-fund`，并设置 `HUSKY=0`；由于上游无锁文件，不能使用 `npm ci`。
5. 以唯一锚点临时应用三项适配：Vue CLI `publicPath: './'`、Vue Router hash 模式、Axios 请求基址读取 `VUE_APP_LOCAL_API_BASE_URL`。脚本结束时恢复这三个源码文件；上游结构变化导致锚点不唯一时立即失败。
6. 在 `local/m` 执行上游 `npm run build`。
7. 校验 `local/m/dist/index.html`、入口引用文件、根绝对路径和远程 `uni.webview` 运行时依赖。
8. 将校验通过的 `dist` 复制到 `local/src/hybrid/html` 并复验；失败时保留错误现场供排查，不恢复旧输出。

H5 源码不是可直接加载的网页制品；只有上述适配后的 `dist` 能进入 APK。

## 5. WebView 页面

- local 启动页加载 `/hybrid/html/index.html#/index`。
- online 启动页读取 `VUE_APP_WEBVIEW_URL`。
- 两个页面均使用自定义导航样式并显示加载错误提示。
- local 的局域网地址允许 HTTP，因此 Android 模板显式启用明文流量；生产网络仍应优先使用 HTTPS。

## 6. 统一前端编排

`scripts/build-app-plus.js` 是唯一 App-plus 构建实现；`build:wgt` 与 `build:apk` 直接复用它导出的构建函数。`scripts/utils/` 只保留至少被两个不同业务脚本直接调用的公共函数，local-assets 专属实现保留在 `scripts/build-local-assets.js`：

1. 解析源 `manifest.json`。
2. 目标配置 `localAssets` 时先执行 local H5 构建一次；online 跳过。
3. 删除旧 App-plus 输出并调用子项目 `npm run build:app-plus`。
4. 校验输出目录、生成的 `manifest.json`、App ID、versionName 和 versionCode。

命令关系：

- `build:local-assets`：只准备 local H5。
- `build:app-plus`：准备目标所需本地资源并构建一次 App-plus。
- `build:wgt`：复用同一 App-plus 实现；开始时删除旧 WGT 输出目录，在正式目录中创建并校验新 WGT。
- `build:apk`：复用同一 App-plus 实现，再创建一次性 APK 输入快照；开始 APK 阶段时删除旧 APK 输出目录。
- `build:image`：只构建 Android 镜像，与目标、`.env`、H5 和 UniApp 构建无关。
- `update:version`：选择一个目标后读取统一 `manifest.json` 版本，直接选择 `patch`、`minor` 或 `major`，不再区分 WGT/APK 发布类型；预览并确认后原子更新 `versionName`，同时将 `versionCode` 加一。

### 6.1 统一版本更新规则

执行：

```bash
npm run update:version
npm run update:version -- --target online
npm run update:version -- --target local
```

交互流程固定为：

1. 未传 `--target` 时选择 online 或 local；传入时校验目标并跳过项目选择。
2. 读取目标 `src/manifest.json`，展示当前 `versionName` 和 `versionCode`。
3. 展示语义化版本规则，固定按 `patch`、`minor`、`major` 从小到大逐行说明：`patch` 修订版本加一，`minor` 次版本加一且修订版本归零，`major` 主版本加一且次版本、修订版本归零；`versionCode` 单独说明为每次固定加一。选择列表使用单行选项直接预览三个 `versionName` 结果，不展示适用范围：

```text
当前版本 · online
  versionName  1.4.7
  versionCode  108
升级方式
  patch  修订版本 +1
  minor  次版本 +1，修订版本归零
  major  主版本 +1，次版本和修订版本归零
  versionCode 每次发布固定 +1：108 → 109
? 请选择版本升级级别
❯ patch（修订）  1.4.7 → 1.4.8
  minor（次版）  1.4.7 → 1.5.0
  major（主版）  1.4.7 → 2.0.0
```
4. 用户选择升级级别；无论选择哪一级，`versionCode` 都在当前值上加一。
5. 展示所选级别以及 `versionName`、`versionCode` 的新旧值，默认不确认；只有用户明确确认才写入。
6. 原子更新清单中唯一的顶层 `versionName` 和 `versionCode` 字符串字段，回读确认版本正确且其他内容未变化；失败时恢复原文件。

版本更新与产物类型解耦。更新后由用户单独执行 `build:wgt`、`build:apk` 或两者；紧急 APK 修复可以选择 `patch`，存在兼容性变化的 WGT 也可以选择 `minor` 或 `major`。

## 7. Android 镜像与权限基线

镜像标签为 `android-builder:5.24.2026081301-r6`，平台固定 `linux/amd64`。镜像构建阶段安装 JDK 17、Android SDK 35、Build Tools 35.0.0、Gradle 8.11.1，并通过联网预热构建形成运行时离线缓存。运行 APK 构建时使用 `--network=none` 和 Gradle `--offline`。

`android-project/simpleDemo/src/main/AndroidManifest.xml` 是 APK 原生权限事实源。当前模板显式声明：

- 网络与 Wi-Fi 状态；
- 相机、录音、振动和唤醒；
- 粗略/精确位置；
- Android 12 之前和之后的蓝牙权限；
- 可选相机、自动对焦和低功耗蓝牙硬件能力。

UniApp `src/manifest.json` 中的权限不会被当前离线原生模板自动合并，因此新增权限必须同步修改 Android 模板、提高镜像修订号、更新本文并验收最终 APK Manifest。

当前 Android 权限按实际业务代码最小化：仅保留联网和分版本 BLE 权限。`INTERNET` 用于 WebView、局域网 API 和打印图片读取；Android 11 及以下使用 `BLUETOOTH`、`BLUETOOTH_ADMIN`，Android 6 至 9 的 BLE 扫描使用粗略位置，Android 10 至 11 使用精确位置；Android 12 及以上仅使用 `BLUETOOTH_SCAN` 和 `BLUETOOTH_CONNECT`，扫描声明 `neverForLocation`。Honeywell 扫码通过专用系统服务广播，不使用系统相机；代码不使用麦克风、振动、唤醒锁、Wi-Fi 控制、联系人、电话、共享存储或媒体库，因此不声明相关权限。模板同时阻止 DCloud AAR 合并无业务依据的存储、媒体、桌面角标和设备标识权限，最终结果以构建后 APK 的权限列表为准。

Honeywell 扫码当前不兼容 `targetSdkVersion >= 34` 的动态广播接收器规则；升级目标 SDK 前必须使用带 `RECEIVER_EXPORTED` 或 `RECEIVER_NOT_EXPORTED` 标志的注册方式，增加权限无法解决该问题。

## 8. APK 构建与发布

执行：

```bash
npm run build:apk -- --target online
npm run build:apk -- --target local
```

流程：

1. 先读取私有配置和源 manifest，确认 App ID 与名称一致，再执行前端构建。
2. App-plus 构建通过后，创建仓库根目录下的一次性 APK 输入目录，并先删除、重建 `output/<target>/apk`。
3. 一次性输入包含运行时 `config.json`、本次 App-plus、可选 override 和 secrets。
4. Docker 输入只读、正式输出目录可写，容器断网并移除 Linux capabilities。
5. 容器复制只读模板和 Gradle 缓存到 `/work`，注入配置、资源和签名后离线构建，并使用 `apksigner` 验证 APK 签名结构。
6. 容器成功后清空挂载的正式输出目录并写入唯一 APK。
7. 宿主再次校验正式输出只包含一个非空普通 APK 文件。
8. 构建成功或失败均删除一次性输入目录；失败不恢复已删除的旧 APK。

## 9. 容器输入与 APK 输出

一次性输入：

```text
/input/
├── config.json
├── resources/apps/<appid>/www/
├── override/                  # 可选
└── secrets/                   # 私有
```

正式输出只保留一个 APK：

```text
output/<target>/apk/
└── <name>-<versionName>-<versionCode>.apk
```

容器在临时 Android 工程内完成 release 构建并使用 `apksigner verify` 验证签名结构，随后清空正式输出目录并复制 APK。宿主要求输出目录只包含一个非空普通 APK 文件。

### 9.1 APK 附加产物留档

早期实现曾随 APK 生成以下三个附加产物：

| 附加产物 | 原用途 | 必要性结论 |
| --- | --- | --- |
| `<apk>.sha256` | 保存 APK 的 SHA-256，用于传输或存储后的完整性比对 | Android 安装和本次同步构建不需要；需要校验时可直接对 APK 计算摘要 |
| `build-metadata.json` | 记录 App ID、Android 包名、namespace、版本、模板、镜像、APK 文件名、大小和摘要，供构建追溯与宿主复验 | 属于追溯信息，不是 APK 构建、签名或安装的必要输入和输出 |
| `COMPLETE` | 保存 APK 摘要并表示容器写出流程完成 | `docker run` 的同步退出码已经表达成功或失败，与摘要和文件校验重复 |

本版本选择精简输出：不再生成、复制或校验上述附加产物，正式目录只保留 APK。该表仅记录附加产物的历史用途和取舍依据，不代表当前实现仍支持这些文件。若以后存在制品仓库追溯、跨系统异步投递或离线传输验签需求，应作为独立需求重新设计，不默认恢复全部附加文件。

## 10. `override` 白名单

仅允许覆盖 `simpleDemo` 下的应用图标、推送图标、启动图、launcher 图标、`colors.xml` 和 `styles.xml`。禁止覆盖 Gradle、Manifest、脚本、源码、AAR/JAR、App-plus 资源和签名配置。绝对路径、`..`、符号链接和特殊文件必须拒绝。

## 11. 安全与版本控制

- 忽略 `local/m`、生成的 `local/src/hybrid/html`、旧 `config/*/resources`、真实 `.env`、私有 config、secrets 和所有输出。
- 模板内 `test.jks` 只用于镜像预热，不得用于正式 APK。
- 不在日志、元数据、命令行或 Docker 环境变量中传递密码和 App Key。
- Docker 下载 URL 和基础镜像目前尚未全部固定 SHA-256/digest；因此当前实现具备运行时断网能力，但镜像制作供应链尚未达到严格可复现级别。

## 12. 验收标准

自动化必须覆盖目标过滤、manifest 解析、local 环境变量、适配锚点、H5 制品校验、App-plus 身份、路径安全、Android 权限、Docker 参数和输出完整性。

发布前还必须实际完成：

1. 人工准备 `local/m` 和 `local/.env`，执行 `build:local-assets`，确认 `hybrid/html` 完整；构建失败时确认旧输出已删除并保留可排查的 `local/m/dist`。
2. 分别构建 online/local App-plus，确认 local 包含 H5，online 不包含 local H5。
3. 分别构建 WGT，解包确认身份、版本和 local 静态资源完整。
4. 构建 r6 镜像，再分别构建 APK；检查最终 Android Manifest 权限、APK 签名有效性和 App-plus 资源。
5. 验证 `build:image` 不触发任何前端构建。
6. 真机验证 local 静态页面离线启动、Hash 路由、局域网 API、Bridge、扫码、蓝牙、称重和打印；验证 online WebView 地址加载。

缺少 `local/m`、真实 `.env`、私有 config、keystore、Docker 或真机时，应将对应步骤报告为阻塞，不得宣称端到端验收通过。