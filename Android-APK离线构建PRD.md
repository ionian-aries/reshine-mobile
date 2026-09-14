# Reshine Mobile 双应用 Android APK 离线构建产品需求文档

## 1. 文档目标

本文是 `reshine-mobile` 中 online、local 双应用管理，以及 Android APK Docker 离线构建的唯一现行基准。只记录当前有效方案。

## 2. 应用与配置边界

| 目标 | UniApp 工程 | App ID | 定位 |
| --- | --- | --- | --- |
| online | `online/` | `__UNI__EF1708F` | 在线应用 |
| local | `local/` | `__UNI__526C783` | 本地应用 |

两者共享官方 HBuilderX `5.24.2026081301` Android 工程和固定 Docker 镜像，独立管理 AppID、包名、版本、App Key、App-plus 资源、签名和 APK。

### 2.1 `.env`

- `online/.env`、`local/.env` 只保存会编译进前端的地址等非敏感配置。
- 仓库只提交 `.env.example`，忽略 `.env` 及所有环境变体；开发人员按示例创建真实文件。
- `.env` 中的值会进入前端制品，不能存放令牌、DCloud App Key、keystore 密码或其他 Secret。
- `.env` 只由各 UniApp 子项目的前端构建读取，不复制到 APK 输入、不挂载进 Docker，也不参与 `build:image`。
- 当前脚手架尚未消费这些地址变量；示例字段分别为 `VUE_APP_WEBVIEW_URL` 和 `VUE_APP_LOCAL_API_BASE_URL`，业务接入时必须在源码中显式读取。

### 2.2 Android 私有输入

Android 普通配置与敏感值继续保存在不提交 Git 的 `config/<target>/config.json`；keystore 位于 `config/<target>/secrets/`。Secret 不通过 Docker 环境变量或命令行参数传递。

## 3. 目录规范

```text
reshine-mobile/
├── online/
│   └── .env.example
├── local/
│   └── .env.example
├── android-project/                     # 官方 HBuilder-Integrate-AS 基线
│   ├── build.gradle
│   ├── settings.gradle                  # include ':simpleDemo'
│   ├── gradle.properties
│   ├── gradlew
│   ├── gradle/wrapper/
│   └── simpleDemo/                      # 保留官方模块名和合法示例配置
├── docker/
│   ├── entrypoint.sh                    # build:apk 容器入口
│   ├── prepare-project.js               # 准备本次临时 Android 工程
│   └── export-metadata.js               # 导出非敏感 APK 元数据
├── scripts/
│   ├── build-image.js
│   ├── build-apk.js
│   ├── build-app-plus.js
│   ├── build-wgt.js
│   ├── init-uniapp.js
│   ├── update-version.js
│   └── utils/
├── config/
│   ├── online/
│   │   ├── config.json
│   │   ├── override/
│   │   └── secrets/<certificate>.keystore
│   └── local/
│       ├── config.json
│       ├── override/
│       └── secrets/<certificate>.keystore
├── output/<target>/{apk,wgt}/
├── Dockerfile
├── build.config.json
└── package.json
```

`resources/apps` 不再是长期私有输入。`build:apk` 每次使用本次 App-plus 输出创建系统临时输入快照，成功或失败后删除。

## 4. Android 官方模板原则

`android-project/` 复制自：

```text
/Users/zhuanghengheng/Works/8.31金川瑞翔-new/Android-SDK@5.24.82669_20260813/HBuilder-Integrate-AS
```

必须保留：

- `simpleDemo` 模块名；
- 官方 Gradle Wrapper、AGP、仓库、SDK 版本和 Maven 依赖；
- 官方 AAR/JAR、JNI、资源、App-plus 示例和 `test.jks`；
- 合法默认 namespace、applicationId、版本、AppID、应用名和测试签名。

只允许加入项目确需的原生权限、组件、模块和依赖。不得将模板改成包含 `@APPLICATION_ID@` 等非法占位符的半成品，也不增加非必需的运行时 Gradle 配置层。业务配置仅修改容器内临时副本。

新增原生模块、AAR/JAR、Maven 依赖、Manifest 组件或权限时，必须更新模板、镜像修订号和本文，并重新执行完整镜像与双应用验收。

## 5. `build.config.json`

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
      "apk": { "inputDir": "config/local" },
      "output": { "wgtDir": "output/local/wgt", "apkDir": "output/local/apk" }
    }
  }
}
```

`apk.image` 是 `build:image` 和 `build:apk` 的唯一镜像引用。模板、工具链、依赖或容器脚本变化时必须提高 `-r<revision>`，旧标签不得覆盖。

## 6. 私有 `config.json`

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

要求：

- 文件不提交 Git，建议权限 `0600`。
- 源 `manifest.json` 是 AppID、名称和版本事实源；`build:apk` 不回写私有 `config.json`，只在临时输入快照中同步版本。
- `storeFile` 必须是 `secrets/` 下安全相对路径。
- online/local 不共享 config、keystore 或输出目录。

## 7. `override` 白名单

可选 `override/` 的路径相对 Android 工程根目录，只允许：

```text
simpleDemo/src/main/res/drawable*/icon.png|webp
simpleDemo/src/main/res/drawable*/push.png|webp
simpleDemo/src/main/res/drawable*/splash.png|webp
simpleDemo/src/main/res/mipmap*/ic_launcher.png|webp
simpleDemo/src/main/res/mipmap*/ic_launcher_round.png|webp
simpleDemo/src/main/res/values/colors.xml
simpleDemo/src/main/res/values/styles.xml
```

禁止覆盖 Gradle、Wrapper、脚本、Manifest、AppID/App Key/App 名配置文件、AAR/JAR、`test.jks`、正式 keystore 和任何工程控制文件。拒绝绝对路径、`..`、符号链接和特殊文件。

## 8. `build:image`

执行：

```bash
npm run build:image
```

处理流程：

1. `scripts/build-image.js` 读取 `apk.image`，执行固定 `linux/amd64` 的 `docker build`。
2. Docker 安装固定 JDK 17、Node 22、Android command-line tools、platform-tools、Android 35 platform、build-tools 35.0.0 和 Gradle 8.11.1 distribution。
3. Wrapper distribution URL 改为镜像内文件，运行时不访问 Gradle 官网。
4. 复制干净官方模板到 `/opt/template`。
5. 复制模板至临时联网工程，执行一次完整构建：

```bash
./gradlew --no-daemon --refresh-dependencies clean :simpleDemo:assembleRelease
```

6. 要求 release APK 生成且 `apksigner verify` 成功；该构建使用官方示例资源和 `test.jks`，同时将正式 APK 构建所需的 Gradle/Maven 依赖完整写入 `/opt/gradle-home`。
7. 删除联网工程和其中的构建产物，只保留干净 `/opt/template`、Android SDK、Gradle distribution 以及联网构建形成的 Gradle/Maven 缓存。
8. 最终镜像复制并只读保存上述模板、固定工具链和缓存，以及 `docker/*` 脚本，并切换到非 root `builder` 用户。Dockerfile 将 `COPY docker /opt/scripts` 放在联网预热层之后，因此只修改容器脚本时可复用耗时的 Gradle 预热缓存层。
9. 宿主执行 `docker image inspect` 确认镜像存在。

镜像阶段只执行一次联网完整 APK 构建，不重复执行第二次离线 APK 构建。离线能力由后续 `build:apk` 的 `--network=none` 容器和 Gradle `--offline` 实际构建验证；如果联网预热未缓存完整依赖，业务 APK 构建会明确失败。

不使用 `prepare-cache-input`、假业务资源、正式配置、正式 App Key 或正式证书。真实完整构建用于填充可复用缓存，并验证官方模板本身可生成有效 APK。

## 9. `build:apk` 宿主流程

执行：

```bash
npm run build:apk -- --target online
npm run build:apk -- --target local
```

未传目标时在交互终端单选，非交互环境必须显式传入 `--target`。

流程：

1. 读取 target、UniApp manifest、私有 config 和镜像引用，校验 AppID/名称一致以及 Android/签名关键字段。
2. 以 manifest 的 versionName/versionCode 为本次唯一版本，不修改源 config。
3. 删除旧 `dist/build/app-plus`，在目标子项目执行 `npm run build:app-plus`。
4. 校验本次 App-plus 输出非空，其 manifest 的 AppID和版本与源码一致。
5. 在正式 APK 输出目录的同级 `.staging/` 下创建唯一运行目录。该目录位于项目共享路径内，可被 Docker Desktop 或 Colima 虚拟机稳定绑定挂载，成功或失败后都会删除：

```text
<input>/
  config.json                    # 本次同步版本后的运行时副本
  resources/apps/<appid>/www/   # 本次 App-plus 输出
  override/                      # 可选副本
  secrets/                       # 私有签名副本
<output>/                        # 容器暂存输出
```

6. 启动固定镜像：`--rm --platform=linux/amd64 --network=none --cap-drop=ALL --security-opt=no-new-privileges`；输入只读、输出可写。运行时 config 同步记录预期镜像引用，容器通过环境变量接收实际镜像标识并在导出 metadata 前比对；不通过环境变量传 Secret。
7. 容器成功后，宿主校验 APK、`.sha256`、`build-metadata.json`、`COMPLETE` 的文件集合、摘要、AppID、包名和版本。
8. 通过后将暂存输出原子替换正式 `output/<target>/apk`；失败保留上一版成功产物。
9. 无论成功失败都删除本次 `.staging/` 运行目录；没有其他并发构建时同时移除空的 `.staging/` 父目录。

## 10. 容器 `build:apk` 流程

`docker/entrypoint.sh` 是镜像入口，仅负责：

1. 检查 `/input/config.json`、`/opt/template` 和可写 `/output`。
2. 将只读 `/opt/gradle-home` 复制成 `/work/gradle-home`。
3. 调用 `prepare-project.js /opt/template /input /work/project`。
4. 执行 `./gradlew --offline --no-daemon --stacktrace clean :simpleDemo:assembleRelease`。
5. 要求 release APK 恰好一个，使用 `apksigner` 验证签名并读取证书 SHA-256。
6. 调用 `export-metadata.js` 生成非敏感 metadata、目标文件名和 APK 摘要。
7. 输出 APK、`.sha256`、`build-metadata.json`，最后写 `COMPLETE`。
8. 退出时删除项目、缓存和发布临时目录。

`docker/prepare-project.js` 事务式执行：

1. 解析和校验运行时 config。
2. 复制干净模板到 `/work` 随机临时目录，并将临时副本规范化为当前非 root 用户可写，同时保留 `gradlew` 等原有可执行文件的执行位；镜像内 `/opt/template` 继续保持只读。
3. 在临时 `simpleDemo/build.gradle` 中精确且唯一地替换 namespace、applicationId、版本和四个签名字段。
4. 修改 `strings.xml` 的 App 名、`dcloud_control.xml` 的 AppID、Manifest 的 DCloud App Key。
5. 删除官方示例 apps，复制本次 `resources/apps/<appid>` 并校验其 AppID和版本。
6. 应用白名单 override。
7. 将正式证书复制为临时 `simpleDemo/release.keystore`。
8. 全部成功后原子形成 `/work/project`；失败删除临时工程。

镜像内模板永不原地修改。正式签名和 App Key只存在于只读输入及容器临时工程，不进入镜像层和输出。

## 11. 产物

正式目录只包含：

```text
output/<target>/apk/
├── <name>-<versionName>-<versionCode>.apk
├── <apk>.sha256
├── build-metadata.json
└── COMPLETE
```

metadata 包含 schema 版本、应用身份、包名、namespace、版本、模板版本、实际镜像引用、APK 文件名/大小/SHA-256 和签名证书 SHA-256。不得包含 App Key、密码或 keystore 路径/内容。

`COMPLETE` 内容为 APK SHA-256，并最后写入。消费者只有看到它后才读取本次产物。

## 12. Secret 与 Git

- 忽略 `config/*/config.json`、`config/*/secrets/`、真实 `.env`、`*.keystore`、`*.jks`、`*.p12`、`*.pfx`。
- 唯一例外是官方模板自带 `android-project/simpleDemo/test.jks`，只用于镜像预热与离线验收，禁止用于正式 APK。
- `android-old/` 整体忽略且不进入镜像。
- 禁止日志打印 config 全文、App Key、密码或证书内容。
- 已经进入 Git 历史或暂存区的正式证书与密码必须人工移除并轮换；忽略规则不能清除历史泄露。

## 13. 其他根命令

- `init:uniapp -- --targets online,local`：初始化指定子项目依赖。
- `build:app-plus -- --target <target>`：删除旧输出并构建一个目标 App-plus。
- `build:wgt -- --target <target>`：构建、校验并输出一个目标 WGT，不读取 Android config 或签名。
- `update:version -- --target <target>`：交互选择 WGT/APK 版本级别，只原子更新目标 `src/manifest.json`。

## 14. 安全和失败语义

- APK 容器完全断网、非 root、输入只读、输出独立可写。
- 不挂载宿主 Gradle 缓存、源码或 Android 工程。
- 动态输入校验路径边界、符号链接、普通文件类型和 override 白名单。
- 任一步骤失败不得写 `COMPLETE`，不得替换上一版正式 APK。
- 项目输出目录同级的 `.staging/` 输入快照和容器临时工程在退出时删除；源 config、secrets、override 和模板不得变化。
- 镜像依赖必须为固定版本；新增依赖必须重新执行一次完整联网预热，并通过后续断网业务 APK 构建验收。

## 15. 验收标准

### 15.1 自动测试

- target 参数、manifest JSONC 与版本解析；
- config schema 与安全相对路径；
- 官方 `simpleDemo` 路径和精确唯一替换；
- XML/Groovy 特殊字符；
- App-plus AppID/版本；
- override 白名单、路径穿越和符号链接；
- metadata、SHA-256、输出文件集合；
- Docker `--network=none` 和只读输入；
- 构建失败保留旧成功产物。

### 15.2 镜像与端到端

1. 从无可用业务输入状态执行 `build:image`，一次联网完整构建成功并生成签名有效的官方示例 APK。
2. 确认最终镜像保留联网构建形成的 Gradle/Maven 缓存，且 `/opt/template` 不包含联网工程的构建产物。
3. online、local 分别使用新容器、`--network=none` 和 Gradle `--offline` 构建成功；该步骤同时作为镜像离线能力验收。
4. 验证 APK 包名、versionName、versionCode、UniApp AppID、应用名、签名指纹和 SHA-256。
5. 按 online、local、online 顺序构建，确认身份、资源和签名不串用。
6. 构建前后模板和私有源输入不变。
7. 缺依赖、错误签名、错误 AppID/版本、越权 override 和符号链接输入均明确失败，且保留旧成功产物。
8. 日志、metadata 和输出中不存在 App Key、密码或 keystore。

## 16. 最终能力

使用固定 HBuilderX `5.24.2026081301` 官方 `simpleDemo` 模板和镜像内离线工具链，接收一个目标的一次性只读输入快照，在临时工程中注入 Android 配置、App-plus 资源、白名单覆盖和正式签名，完全断网生成并验证 APK；online/local 的前端 `.env`、Android 私有配置、资源、签名和输出彼此隔离。