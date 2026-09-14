# Reshine Mobile 双应用 Android APK 离线构建产品需求文档

## 1. 文档目标

本文定义 `reshine-mobile` 项目中 online 在线版和 local 本地版 UniApp 应用的管理方式，以及使用固定 Android Docker 镜像构建签名 APK 的输入、输出、安全和验收规范。

本文只记录最终技术结论和实施方案。

## 2. 产品与项目定位

`reshine-mobile` 管理两个独立应用：

| 应用 | UniApp 工程 | App ID | 定位 |
| --- | --- | --- | --- |
| online | `online/` | `__UNI__EF1708F` | 通过 WebView 加载在线 HTTPS 制品地址 |
| local | `local/` | `__UNI__526C783` | 将 H5 静态制品放入 `hybrid/html` 后随 App 资源发布 |

两个应用共享 Android 构建模板、原生能力基线和 Docker 构建镜像，但独立管理以下内容：

- UniApp 源码和 App ID；
- DCloud App Key；
- Android 包名和 `namespace`；
- `versionCode` 和 `versionName`；
- HBuilderX 生成的 App 资源；
- Android 构建配置；
- keystore、密钥别名和密码；
- 可选 Android 资源覆盖；
- APK 和构建报告。

## 3. 总体架构

```text
online或local UniApp源码
  -> HBuilderX 5.24.2026081301生成App资源
  -> 放入对应config/<project>/resources/apps/<appid>/www
  -> 将config/<project>只读挂载到Docker /input
  -> 镜像从固定Android模板创建临时工程
  -> 注入config.json、App资源、可选override和签名材料
  -> 使用固定离线工具链构建并验证签名
  -> 将最终产物写入output/<project>
```

Docker 运行时只使用两个宿主机挂载：

1. 当前应用的构建输入，只读挂载到 `/input`；
2. 当前应用的构建输出，可写挂载到 `/output`。

不挂载 UniApp 源码、完整 Android 工程、Gradle 缓存或镜像模板目录。

## 4. 仓库目录规范

```text
reshine-mobile/
├── online/                              # online UniApp源码
├── local/                               # local UniApp源码
├── scripts/
│   ├── init-uniapp.js                   # 依次初始化各UniApp子项目依赖
│   ├── build-app-plus.js                # 依次构建各UniApp子项目App资源
│   ├── build-wgt.js                     # 依次构建各UniApp子项目WGT
│   └── update-version.js                # 方向键单选并更新单个应用版本
├── build.config.json                    # UniApp子项目及WGT输出配置
├── package.json                         # 根目录构建编排入口，使用ES Module
├── android/                             # 当前Android模板来源；正式镜像使用净化后的固定模板
├── config/
│   ├── online/
│   │   ├── config.json                  # 完整配置及敏感值，不提交Git
│   │   ├── resources/
│   │   │   ├── apps/
│   │   │   │   └── __UNI__EF1708F/
│   │   │   │       └── www/
│   │   │   └── android/                 # 可选标准图标、启动图等
│   │   ├── override/                    # 可选白名单Android资源覆盖
│   │   └── secrets/
│   │       └── release.keystore         # 不提交Git
│   └── local/
│       ├── config.json                  # 完整配置及敏感值，不提交Git
│       ├── resources/
│       │   ├── apps/
│       │   │   └── __UNI__526C783/
│       │   │       └── www/
│       │   └── android/
│       ├── override/
│       └── secrets/
│           └── release.keystore         # 不提交Git
├── output/
│   ├── online/
│   │   ├── apk/
│   │   └── wgt/                         # 只保存本次online构建的一个WGT
│   └── local/
│       ├── apk/
│       └── wgt/                         # 只保存本次local构建的一个WGT
├── Android-APK离线构建PRD.md
├── agents.md
└── .gitignore
```

`config.json` 与 `secrets/` 由授权人员通过受控私下渠道交付给开发人员，不进入 Git。`resources/` 和 `override/` 可以按项目管理要求选择提交；最终构建时必须位于对应应用输入目录中。

## 5. 根目录 UniApp 依赖初始化

项目根目录使用 Node.js ES Module，根 `package.json` 固定设置 `"type": "module"`。首次拉取项目后，在 `reshine-mobile` 根目录执行：

```bash
npm ci
npm run init:uniapp -- --targets online,local
```

根目录 `npm ci` 安装构建编排工具使用的精确锁定依赖，包括终端交互组件、WGT 压缩组件和 ZIP 结构校验组件。`npm run init:uniapp` 读取根目录 `build.config.json`：交互式终端未传参数时显示 checkbox 多选列表，使用方向键移动、空格勾选、Enter 确认，并要求至少选择一个目标；显式传入 `--targets` 时按逗号分隔值去重并保留首次出现顺序。非交互环境必须显式传入 `--targets`，不得隐式初始化全部目标。

### 5.1 根目录直接依赖与选型结论

根项目当前只声明三个直接运行时依赖，均在 `package.json` 和 `package-lock.json` 中精确锁定版本：

| 依赖 | 固定版本 | 使用位置 | 用途 | 选型结论 |
| --- | --- | --- | --- | --- |
| `@inquirer/prompts` | `7.8.4` | `scripts/update-version.js` | 提供目标、发布类型、APK 版本级别的方向键单选，以及带明确默认值的最终确认 | 当前最优选择 |
| `archiver` | `7.0.1` | `scripts/build-wgt.js` | 将 App-plus 目录内部内容以流式 ZIP 格式写入 WGT | 当前最优选择 |
| `unzipper` | `0.12.3` | `scripts/build-wgt.js` | 独立重新读取并验证生成的 WGT 可解析、非空且没有顶层 `app-plus/` 目录 | 当前最优选择 |

`@inquirer/prompts` 采用官方模块化提示组件，使用 `select`、`checkbox` 和 `confirm`，能够在 macOS、Windows、Linux 的交互式终端提供一致的方向键、空格、Enter 和 `Ctrl+C` 行为。相较自行维护 raw mode、ANSI 光标控制和按键解析，它显著降低终端状态未恢复、组合键解析错误和跨平台差异风险；相较引入完整命令行框架，它的职责更聚焦。该依赖会带来传递依赖，但根锁文件已锁定完整依赖树，且当前项目要求 Node.js 18 或更高版本，与该版本运行要求一致，因此在当前交互需求下属于合理且优先的选择。

`archiver` 支持跨平台、纯 Node.js、流式递归压缩，可直接将目录内部内容写为 ZIP，不依赖宿主系统安装 `zip` 命令。`unzipper` 并非生成 WGT 的必要依赖，但它作为独立读取器验证最终制品，避免只相信压缩写入过程；相较调用不同操作系统的外部解压命令，其行为更稳定且便于在 Node.js 脚本内实施结构校验。因此两者在当前跨平台、流式生成和独立产物校验约束下保持职责分离，不合并或移除。

不新增 JSONC 解析库、语义化版本库或原子写入库。`manifest.json` 包含注释，版本脚本只精确定位并更新唯一的顶层 `versionName`、`versionCode` 字符串字段，同时执行格式、安全整数、字段唯一性、回读一致性和非版本内容不变校验；版本增量规则固定且简单；临时文件加同目录 `rename` 已满足原子替换要求。为这些有限职责继续增加通用依赖不会提高当前正确性，反而会扩大依赖面。

依赖职责保持隔离：`@inquirer/prompts` 只负责交互，不参与版本计算或文件写入；`archiver` 只负责生成 WGT；`unzipper` 只负责验证 WGT。任何依赖升级都必须更新锁文件并重新执行对应交互、构建和产物校验。

### 5.2 UniApp 依赖初始化

```bash
# 交互式多选
npm run init:uniapp

# 非交互环境或明确指定目标
npm run init:uniapp -- --targets online
npm run init:uniapp -- --targets online,local
```

初始化开始前必须完成全局配置和目标参数校验。交互式终端未传参数时显示多选列表，且至少选择一个目标；非交互环境未传参数时立即返回非零退出码并提示使用 `--targets`。显式参数中的重复名称去重并保留首次出现顺序，空名称、未知目标、未知参数或多余参数必须在执行 `npm ci` 前失败。每个目标开始执行 `npm ci` 前，还必须校验 `uniapp.dir` 的真实路径位于项目根目录内，并确认该目录的 `package.json` 和 `src/manifest.json` 存在。

初始化日志必须先展示全部可用项目以及本次选中项目，并在每个项目开始、成功或失败时展示当前序号、总数和项目名称。每个项目的目录解析、工程结构校验及 `npm ci` 独立捕获错误；单个项目失败后继续初始化后续项目。全部项目处理完成后统一输出逐项目结果及成功、失败数量。存在任一失败时，命令最终返回非零退出码；全部成功时返回零退出码。

除 `init:uniapp` 外，发布与产物命令一次只处理一个应用。`build:app-plus`、`build:wgt`、未来的 `build:apk` 和 `update:version` 统一使用单数参数 `--target`：

```bash
npm run build:app-plus -- --target online
npm run build:wgt -- --target local
```

交互式终端未传 `--target` 时显示方向键单选列表；非交互环境未传参数时立即失败。旧 `--targets` 构建接口、未知目标、未知参数和多余参数均在构建开始前拒绝。持续集成系统必须通过矩阵或外层编排分别调用每个目标。

### 5.3 App-plus 构建

`build:app-plus` 一次只构建一个目标。命令完成目标选择后，校验 `uniapp.dir` 的词法路径和真实路径均位于项目根目录内，并确认 `package.json` 和 `src/manifest.json` 存在。随后完整删除该项目的 `dist/build/app-plus`，在项目目录执行 `npm run build:app-plus`，并校验本次生成的输出目录存在且非空。任一步骤失败均立即返回非零退出码，不处理其他目标。

### 5.4 WGT 构建最终流程

根目录提供统一命令：

```bash
# 交互式单选
npm run build:wgt

# 显式构建一个目标
npm run build:wgt -- --target online
npm run build:wgt -- --target local
```

`build:wgt` 一次只构建一个目标。交互式终端未传参数时显示单选列表；非交互环境必须显式传入 `--target`。旧 `--targets`、空名称、未知目标、未知参数或多余参数必须在开始构建前失败。

该单目标必须依次执行以下完整流程：

1. 读取并校验该目标的 `uniapp.dir` 和 `output.wgtDir`；两个路径都必须是项目根目录内的相对路径，且不同目标不得配置相同的 WGT 输出目录。
2. 校验 UniApp 项目目录、`package.json` 和 `src/manifest.json` 存在，读取 `appid`、`versionName` 和 `versionCode`；App ID 和版本信息必须有效。
3. 完整删除该目标的正式 WGT 输出目录并重新创建。旧 WGT 无论是否可用均不保留，因此从此步骤开始，后续失败时该目录保持为空。
4. 完整删除该目标 UniApp 工程中的旧 `dist/build/app-plus`，不复用上一次 App-plus 构建结果。
5. 在该目标的 `uniapp.dir` 中执行 `npm run build:app-plus`。`build:wgt` 直接调用子项目的该命令，不再调用根目录 `build:app-plus`，避免重复遍历目标或重复构建。
6. 校验新生成的 `dist/build/app-plus` 存在、是目录且非空，并校验其中的 App ID、版本等必要信息与 `src/manifest.json` 一致。
7. 将 `dist/build/app-plus` **目录内部的全部内容**压缩为 ZIP 格式的 `.wgt` 文件。压缩包根目录直接包含 `manifest.json`、`www/` 等 App-plus 内容，不得包含顶层 `app-plus/` 目录。根 Node 项目固定使用锁定版本的 `archiver` 完成压缩，并使用 `unzipper` 重新读取产物进行结构校验。
8. WGT 文件名固定为 `<appid>.wgt`，直接写入该目标的 `output.wgtDir`。不创建临时构建目录、暂存目录、历史版本目录或备份文件。
9. 校验输出目录中恰好存在一个 `.wgt` 文件，文件名正确、大小大于零、ZIP 结构可读取，确认压缩包根目录不包含 `app-plus/` 包装层，并回读压缩包根目录 `manifest.json` 校验 App ID、`versionName` 和 `versionCode` 与源清单一致。
10. 输出该目标的成功状态、WGT 路径、App ID 和版本信息。日志不得输出敏感配置。

该目标从配置解析、目录清理、App-plus 构建、压缩到产物校验作为一个完整任务执行。任一步骤失败后必须清空其 `output.wgtDir`，输出明确原因并返回非零退出码；成功时返回零退出码。

WGT 构建不执行 Android Gradle 构建，不读取 APK 的 `config/<project>/config.json`、签名材料或 `override/`，也不复制 App-plus 结果到 `config/<project>/resources/`。`dist/build/app-plus` 仅作为对应 UniApp 子项目内的本次编译中间结果保留；最终交付制品只有 `output.wgtDir` 中的一个 WGT 文件。

`build.config.json` 固定为以下结构：

```json
{
  "targets": {
    "online": {
      "uniapp": {
        "dir": "online"
      },
      "output": {
        "wgtDir": "output/online/wgt"
      }
    },
    "local": {
      "uniapp": {
        "dir": "local"
      },
      "output": {
        "wgtDir": "output/local/wgt"
      }
    }
  }
}
```

`uniapp.dir` 和 `output.wgtDir` 必须是位于项目根目录内的路径。脚本在执行 `rm`、`npm` 或写入 WGT 前，还必须解析目标或最近存在父目录的真实路径，拒绝通过符号链接逃逸到项目根目录外。`scripts/utils/` 只保存至少被两个命令脚本使用的通用功能模块：配置与路径解析、单目标参数与交互、子进程执行、Manifest 内容解析校验；初始化专用的多目标参数与多选交互，以及 App-plus、WGT、版本写入等命令业务流程固定保留在对应脚本内。根 `package.json` 固定提供 `init:uniapp`、`build:app-plus`、`build:wgt` 和 `update:version` 四个编排入口；根 `package-lock.json` 锁定终端交互、WGT 压缩与 WGT 校验的完整依赖树。初始化脚本不安装根目录依赖，不执行 UniApp 构建，不生成 App 资源，也不处理 Docker APK 构建。

## 6. 输入契约

容器内固定输入结构为：

```text
/input/
├── config.json
├── resources/
│   ├── apps/
│   │   └── <appid>/
│   │       └── www/
│   └── android/                         # 可选
├── override/                            # 可选
└── secrets/
    └── release.keystore
```

约束如下：

- `/input` 必须只读挂载；
- `config.json` 是唯一配置文件，包含普通配置和签名敏感值；
- keystore 固定放在 `/input/secrets/`；
- HBuilderX App 资源固定放在 `/input/resources/apps/<appid>/www`；
- UniApp 源码不能替代 HBuilderX 已生成的 App 资源；
- 输入目录不得包含完整 Android Gradle 工程；
- 输入路径不得包含符号链接逃逸、绝对外部路径或 `..` 路径段。

## 7. `config.json` 规范

online 配置结构如下，local 使用相同结构并替换为自身参数：

```json
{
  "schemaVersion": 1,
  "templateVersion": "5.24.2026081301",
  "app": {
    "name": "金川瑞翔在线版",
    "applicationId": "com.jinchuan.reshine_mobile_online",
    "namespace": "com.jinchuan.reshine_mobile_online",
    "versionCode": 100,
    "versionName": "1.0.0",
    "minSdk": 21,
    "targetSdk": 33
  },
  "dcloud": {
    "appid": "__UNI__EF1708F",
    "appKey": "实际DCloud App Key"
  },
  "resources": {
    "appDirectory": "resources/apps/__UNI__EF1708F"
  },
  "signing": {
    "storeFile": "secrets/release.keystore",
    "keyAlias": "实际密钥别名",
    "keyPassword": "实际密钥密码",
    "storePassword": "实际证书库密码",
    "v1Enabled": true,
    "v2Enabled": true
  }
}
```

配置要求：

- `config.json` 不提交 Git；
- 不通过 Docker `-e` 传递 App Key 或签名参数；
- `storeFile` 必须是 `/input` 下的相对路径，并固定指向 `secrets/`；
- `applicationId` 和 `namespace` 原则上保持一致；
- `versionCode` 为正整数且每个应用独立递增；
- `versionName` 由两个应用独立维护；
- `templateVersion` 必须与镜像模板版本完全一致；
- `appid` 必须与 App 资源目录及资源内部声明一致；
- online 和 local 不得共用同一个 `config.json`。

## 7. `override` 规范

`override/` 仅用于配置和标准资源目录无法表达、且被镜像白名单允许的 Android 资源差异。没有特殊差异时可以不创建该目录。

允许覆盖的典型内容：

```text
override/
└── app/
    └── src/
        └── main/
            └── res/
                ├── drawable/
                ├── drawable-xxxhdpi/
                ├── mipmap-xxxhdpi/
                ├── values/
                └── xml/
```

允许内容包括：

- 应用图标和启动页图片；
- 颜色、样式和图片资源；
- 经审核的 `res/xml` 配置；
- 镜像发布时明确列入白名单的其他 Android 资源。

禁止通过 `override/` 提供：

- `build.gradle`、`settings.gradle` 或 `gradle.properties`；
- 完整 `AndroidManifest.xml`；
- AAR、JAR、Gradle 插件或 Maven 依赖；
- Shell 脚本和可执行文件；
- HBuilderX App 资源；
- keystore 或密码文件；
- 任意目标路径或完整 Android 工程。

覆盖按精确白名单映射到临时工程，不允许将 `override/` 整体递归合并到模板。

## 9. Secret 管理

敏感内容包括：

- `config.json` 中的 DCloud App Key；
- `keyAlias`、`keyPassword` 和 `storePassword`；
- `secrets/release.keystore`。

管理要求：

- `config/*/config.json` 和 `config/*/secrets/` 不提交 Git；
- online 与 local 分别保存自己的配置和 keystore；
- 通过企业密码管理器、加密介质或其他受控渠道交付；
- 仅授权需要执行正式签名构建的人员访问；
- 不通过公开仓库、普通群聊、公开网盘或构建日志传递；
- macOS/Linux 上将文件权限设置为仅当前用户可读写；
- 容器不得打印完整配置、App Key、密码或 keystore 内容；
- 敏感文件不得进入镜像、临时工程导出、APK、构建报告或 `/output`。

建议权限：

```bash
chmod 600 config/online/config.json
chmod 600 config/online/secrets/release.keystore
chmod 600 config/local/config.json
chmod 600 config/local/secrets/release.keystore
```

## 10. Git 管理

`.gitignore` 必须至少包含：

```gitignore
/config/*/config.json
/config/*/secrets/
/output/
```

禁止使用强制提交将真实配置或 keystore 加入 Git。若敏感内容曾进入 Git，必须视为已经泄露并执行密钥轮换，删除当前文件不能消除历史提交中的内容。

## 11. Docker 构建接口

### 11.1 online

```bash
mkdir -p "$PWD/output/online"

docker run --rm \
  --network=none \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --mount type=bind,src="$PWD/config/online",dst=/input,readonly \
  --mount type=bind,src="$PWD/output/online",dst=/output \
  android-builder:5.24.2026081301-r1
```

### 11.2 local

```bash
mkdir -p "$PWD/output/local"

docker run --rm \
  --network=none \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --mount type=bind,src="$PWD/config/local",dst=/input,readonly \
  --mount type=bind,src="$PWD/output/local",dst=/output \
  android-builder:5.24.2026081301-r1
```

调用约束：

- 每次只构建一个应用；
- 每次创建新容器，构建后由 `--rm` 删除；
- 正式构建必须使用 `--network=none`；
- 不传递任意 Gradle 任务、Shell 命令或外部工程路径；
- 不挂载宿主 Gradle 缓存；
- 正式环境使用不可变镜像标签并优先通过 digest 锁定。

## 12. Docker 镜像职责

镜像固定内置：

- HBuilderX `5.24.2026081301` 对应的净化 Android 模板；
- JDK 17；
- Gradle 8.11.1；
- Android Gradle Plugin 8.7.3；
- Android Platform 35；
- Android Build Tools 35.0.0；
- 完整 Maven 离线依赖闭包；
- DCloud 原生运行时 AAR/JAR；
- 配置 Schema、注入工具、构建入口和 `apksigner`。

镜像不执行：

- UniApp 或 H5 源码编译；
- HBuilderX App 资源生成；
- online 与 local 形态转换；
- 动态安装工具链或依赖；
- 外部完整 Android 工程构建；
- 在线下载回退。

## 13. 容器内构建流程

每次构建固定执行：

1. 校验 `/input` 和 `/output` 挂载及权限；
2. 校验 `config.json` Schema、模板版本和所有字段；
3. 校验 keystore 位于 `/input/secrets/` 且文件存在；
4. 校验 App 资源目录、App ID、文件数量、文件大小和路径安全；
5. 校验 `override/` 中所有文件均命中白名单；
6. 删除并重新创建 `/work/project`；
7. 从只读 `/opt/template` 完整复制干净工程；
8. 校验模板副本与模板文件清单一致；
9. 结构化注入包名、名称、版本、App ID、App Key 和签名配置；
10. 清空模板副本中的 `assets/apps`，仅复制当前应用 App 资源；
11. 应用白名单资源覆盖；
12. 使用镜像固定 Gradle 和 `--offline` 执行 `assembleRelease`；
13. 校验 APK 数量、包名、版本和签名；
14. 在 `/work/publish` 准备产物；
15. 原子发布到 `/output`；
16. 入口退出，由 Docker 删除容器临时状态。

`config.json` 和 `secrets/` 不得复制到 `/work/project`。签名参数只允许通过受控临时配置供 Gradle 使用，临时配置不得输出或导出。

## 14. 输出规范

每个应用使用独立输出目录：

```text
output/<project>/
├── <project>-<versionName>-<versionCode>.apk
├── <project>-<versionName>-<versionCode>.apk.sha256
├── build-metadata.json
└── COMPLETE
```

`build-metadata.json` 只记录非敏感信息：

- 应用标识；
- App ID；
- 包名和 `namespace`；
- `versionCode` 和 `versionName`；
- 模板版本；
- 镜像版本或 digest；
- App 资源摘要；
- APK 文件名和 SHA-256；
- 签名证书公开指纹；
- 构建时间和结果。

不得记录 App Key、密码、keystore 内容或完整 `config.json`。

只有 APK、摘要和元数据全部验证成功后才能写入 `COMPLETE`。构建失败不得用半成品覆盖上一次成功产物。

## 15. 版本管理

### 15.1 唯一事实源与职责边界

每个应用自己的 `src/manifest.json` 是该应用版本的唯一事实源：

- online：`online/src/manifest.json`；
- local：`local/src/manifest.json`。

私有 APK 输入 `config/<project>/config.json` 不作为版本事实源，因为该文件不提交 Git，且只属于 Docker APK 构建输入。后续 APK 输入生成或 APK 构建流程必须从目标 `manifest.json` 读取版本并同步到构建输入，避免人工维护两个版本源。

版本命令只负责严格校验并更新一个目标 `src/manifest.json` 中的 `versionName` 和 `versionCode`。它不修改 `config.json`，不构建 WGT，不启动 Docker，不生成 App 资源，也不修改 Android 模板。

### 15.2 版本规则

`versionName` 必须严格采用 `major.minor.patch` 格式，三个部分均为非负十进制整数：

```text
versionName：major.minor.patch（主版本.次版本.修订版本）
```

发布类型和升级规则固定如下：

| 发布类型 | 允许的升级级别 | 版本变化 |
| --- | --- | --- |
| WGT | patch | `x.y.z -> x.y.(z+1)` |
| APK | minor | `x.y.z -> x.(y+1).0` |
| APK | major | `x.y.z -> (x+1).0.0` |

minor 用于新增需要新 APK 承载的原生能力或较大功能，major 用于原生基线、兼容策略或产品主版本变化。每次主动版本更新，无论发布 WGT 还是 APK，`versionCode` 都必须在原正整数基础上自增 `+1`，并继续以字符串形式写回当前 UniApp `manifest.json`，保持现有文件字段类型。

### 15.3 命令与目标选择

根目录统一命令为：

```bash
# 交互选择目标
npm run update:version

# 直接指定一个目标
npm run update:version -- --target online
npm run update:version -- --target local
```

版本更新一次只允许处理一个目标。未提供参数时，脚本按 `build.config.json` 中 `targets` 的声明顺序显示单选列表，当前项使用单选标记和高亮指示；用户使用上、下方向键移动，按 Enter 确认，不再输入编号。提供 `--target` 时，必须验证该名称存在后直接使用。该命令不支持 `--targets` 多选语义，空值、未知目标、未知参数和多余参数必须在读取或修改目标清单前失败，并显示全部可用目标。

### 15.4 交互与写入流程

命令必须依次执行以下流程：

1. 读取并校验根目录 `build.config.json`，列出全部可用目标。
2. 未提供 `--target` 时显示单选列表，用户通过上、下方向键移动当前项并按 Enter 选定目标；提供参数时校验 `--target <项目>` 指定的唯一目标。
3. 输出 `versionName：major.minor.patch（主版本.次版本.修订版本）`。
4. 使用相同的方向键单选交互选择发布类型 WGT 或 APK。
5. WGT 不再显示升级级别单选，而是明确输出 `WGT 发布固定升级 patch（修订版本）`；APK 使用相同的方向键单选交互显示 `请选择版本升级级别`，选项为 `minor（次版本）` 和 `major（主版本）`。
6. 使用共享路径逻辑解析目标 `uniapp.dir`，确认目录位于项目根目录内，并读取 `src/manifest.json`。
7. 在支持 UniApp 注释的前提下解析清单，严格校验 `versionName` 符合三段格式，`versionCode` 是不含符号、前导空白或小数的正整数字符串，且自增后不超过 JavaScript 安全整数范围。
8. 按发布类型计算新版本，显示目标、发布类型、升级级别以及完整预览：

```text
versionName: <旧值> -> <新值>
versionCode: <旧值> -> <旧值+1>
```

9. 询问 `确认更新以上版本？(y/N)`，界面必须明确显示默认值为“否”。直接按 Enter 或输入 `n`、`no` 均正常取消且不得修改文件；只有明确输入 `y` 或 `yes` 才写入，大小写不敏感。
10. 写入时只替换顶层 `versionName` 和 `versionCode` 的原值，保留清单其余内容、注释、缩进和换行风格；写入临时文件后再原子替换正式文件，避免中途失败留下半个文件。
11. 写入后重新读取文件，校验两个新值与预览完全一致，且除这两个字段外没有主动修改其他配置。
12. 完成时只输出“更新成功”；取消时输出“已取消，未修改版本”；任何校验、读取、写入或回读失败时只输出带原因的“更新失败”并返回非零退出码。成功和取消返回零退出码，不输出后续构建建议。

交互选择必须运行在支持 TTY 的终端中；非交互环境应通过 `--target` 跳过目标选择，但发布类型、APK 升级级别和最终确认仍要求可交互终端。用户按 `Ctrl+C` 中止或终端不可读时必须视为失败，不得采用默认发布类型或升级级别。最终确认默认值为“否”，避免误触 Enter 修改版本；用户必须明确选择“是”才执行更新。

### 15.5 构建与发布的一致性

WGT 构建继续直接读取目标 `src/manifest.json`。APK 发布流程在生成构建输入时必须读取同一清单并将版本同步到私有 `config.json`；Docker 构建入口必须校验 App 资源、清单派生版本和最终 APK 版本一致。版本脚本本身不承担该同步与构建职责。

### 15.6 `update:version` 当前实现归档

当前实现文件为 `scripts/update-version.js`，根命令为 `npm run update:version`。脚本复用 `scripts/utils/config.js` 读取 `build.config.json`、校验目标目录边界并确认 UniApp 工程结构，不另建目标配置来源。

交互和更新行为固定如下：

- 未提供 `--target` 时，通过方向键单选 online 或 local；提供 `--target` 时只跳过目标选择。
- 发布类型通过方向键单选 WGT 或 APK。
- WGT 选择后直接显示 `WGT 发布固定升级 patch（修订版本）`，不再要求选择升级级别。
- APK 显示 `请选择版本升级级别`，选项固定为 `minor（次版本）`、`major（主版本）`。
- 预览必须显示目标、发布类型、升级级别、`versionName` 新旧值和 `versionCode` 新旧值。
- 最终确认显示 `(y/N)`，默认值为“否”；直接按 Enter 或选择“否”正常取消且不修改文件，必须明确选择“是”才执行更新。
- 脚本只更新目标 `src/manifest.json` 中唯一的 `versionName` 和 `versionCode`，保持现有字符串字段类型，不修改其他文件。
- 写入采用同目录临时文件和原子重命名，随后回读并校验版本值以及其他文本未被改变；回读校验失败时恢复原始文件并返回非零退出码。
- `Ctrl+C`、终端不可用、配置错误、未知目标、版本格式错误或写入错误均不得产生成功结果。

该命令是交互式本地发布辅助命令，不提供发布类型、升级级别或确认结果的非交互参数。这样可保留发布前人工预览与确认，同时用 `--target` 减少已知目标场景中的一步选择。

Android 构建镜像版本独立管理，格式为：

```text
5.24.2026081301-r<修订号>
```

模板、工具链、离线依赖、配置 Schema、注入逻辑或安全逻辑变化时必须发布新的镜像修订号，旧标签不得覆盖。

## 16. 发布流程

online 和 local 分别执行以下流程：

1. 更新对应 UniApp 源码；
2. 在项目根目录执行 `npm run update:version` 或通过 `--target` 指定应用，按 WGT 或 APK 发布规则确认并更新该应用的 `manifest.json`；
3. online 配置在线 HTTPS 制品地址，local 更新 `hybrid/html` 静态制品；
4. WGT 发布执行 `npm run build:wgt -- --target <project>`；APK 发布继续执行后续步骤；
5. 使用 HBuilderX `5.24.2026081301` 生成 App 资源；
6. 清空对应 `config/<project>/resources/apps/`；
7. 将本次 `<appid>/www` 放入对应资源目录；
8. APK 输入生成流程从目标 `manifest.json` 读取版本并同步到私有 `config.json`，同时更新其他项目参数；
9. 校验 App ID、包名、版本、资源和 keystore；
10. 创建项目独立输出目录；
11. 使用两个挂载启动一次性 Docker 容器；
12. 检查退出码、`COMPLETE`、APK SHA-256 和签名；
13. 安装 APK 并执行对应应用功能验收。

## 17. 安全要求

- 镜像以非 root 用户执行构建；
- `/input` 和 `/opt/template` 只读；
- `/output` 是唯一持久化写入目录；
- `/work` 和 `/tmp` 只存放本次容器临时文件；
- 正式构建禁用网络并移除 Linux capabilities；
- 禁止模板、输入和 Secret 出现在输出中；
- 禁止在日志、命令行参数和错误消息中输出密码或 App Key；
- 禁止将密码直接作为 Gradle 命令参数；
- 临时签名配置权限必须限制为当前构建用户，并在退出时删除；
- 输入目录必须校验路径穿越和符号链接逃逸；
- 禁止动态版本、动态插件、未知 AAR/JAR 和未锁定依赖；
- 模板和离线依赖必须通过 SHA-256 清单校验。

## 18. 验收标准

### 18.1 双应用隔离

按 online、local、online 顺序使用新容器构建，确认：

- App ID、包名、版本、App 资源、图标和签名不串用；
- output 目录互不影响；
- 每次均从固定模板重新创建工程；
- 输入目录和模板内容不发生变化。

### 18.2 完全离线

- 使用 `--network=none`；
- 不挂载 Gradle 缓存；
- online 和 local 均构建成功；
- 日志不存在下载行为；
- 缺少任一依赖时明确失败。

### 18.3 输入和 Secret

- 缺少 `config.json`、App 资源或 keystore 时明确失败；
- 配置、App 资源和 keystore 在构建前后摘要不变；
- 输入目录不新增 `.gradle`、`build` 或临时文件；
- 日志、APK、元数据和输出目录中不存在 App Key、密码或 keystore；
- 非白名单覆盖、路径逃逸和符号链接逃逸均被拒绝。

### 18.4 APK

- 仅生成一个预期 release APK；
- 包名、版本、App ID 和资源正确；
- `apksigner verify` 通过；
- APK SHA-256 与摘要文件一致；
- online 加载预期在线地址；
- local 在断开业务网络后加载本地 H5；
- 蓝牙、扫码、打印和电子秤等声明能力通过项目功能测试。

## 19. 最终能力定义

本方案提供以下唯一构建能力：

> 使用一个固定 HBuilderX `5.24.2026081301` Android 模板和完全离线工具链，分别接收 online 或 local 的私有 `config.json`、HBuilderX App 资源、可选白名单覆盖及 `secrets/release.keystore`，通过一个只读输入挂载和一个可写输出挂载，创建一次性临时 Android 工程并生成经过签名验证的 APK。

两个应用共享 Docker 镜像和 Android 原生能力基线，但其应用身份、配置、资源、Secret、版本和输出完全独立。