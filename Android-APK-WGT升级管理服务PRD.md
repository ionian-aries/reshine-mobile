# Android APK/WGT 升级管理服务 PRD

> 适用：Android、多应用管理、本地构建 APK/WGT、低代码后台、MinIO

## 1. 目标与边界

建设一套支持多个 UniApp 应用的 APK/WGT 升级管理方案。各应用在外部构建环境完成版本维护及本地构建；升级中心负责产物上传、版本管理、发布、撤回、更新检查和客户端下载安装。

### 1.1 多应用隔离

- 后台支持新增和管理任意数量的 Android 应用。
- 每个应用独立绑定业务标识、UniApp App ID、Android applicationId、MinIO 对象目录和版本序列。
- 文件、版本、发布策略和客户端检查均以应用为隔离边界，禁止跨应用复用文件或下发更新。

### 1.2 版本规则

- `apkVersionName`：客户端当前安装 APK 的版本名，由 `uni.getSystemInfoSync().appVersion` 读取；服务端用它判断 APK 更新及 WGT 的最低整包兼容条件，不使用 `versionCode`。
- `wgtVersionName`：客户端当前实际生效的 App-plus/WGT 资源版本名，由 `plus.runtime.getProperty(appid).version` 读取；尚未热更新时通常等于 APK 内置资源版本。
- `versionCode`：Android 整数版本码，随 APK 正式版本递增并用于系统覆盖安装，不参与服务端候选比较。
- APK 版本名、WGT 版本名和 `minApkVersionName` 均只允许纯数字点分格式，各段按整数比较；禁止 `v1.0.0`、`1.0.0-beta` 等无法可靠比较的格式。
- 同一应用的 APK 与 WGT 共用一条严格单调递增的业务版本序列，任何历史版本均不得重复或倒退，也禁止 APK 与 WGT 使用相同版本。
- 推荐序列：`APK 1.0.0 → WGT 1.0.1 → WGT 1.0.2 → APK 1.1.0 → WGT 1.1.1`。
- APK 与 WGT 的 App ID、版本名及 APK 的 `versionCode` 由发布人根据最终构建产物填写并确认。
- WGT 必须使用 `minApkVersionName` 声明最低适配 APK 版本。

## 2. 总体架构

1. **本地构建端**：执行版本更新并构建 APK/WGT。
2. **管理后台**：管理应用、文件、版本、发布、撤回和审计。
3. **更新检查服务**：按客户端 App ID、平台以及当前 APK/WGT 版本返回可用更新。
4. **MinIO**：保存 APK/WGT；数据库保存版本记录和对象地址。
5. **Android 客户端**：检查、提示、下载并安装 APK/WGT；WGT 按策略重启生效。

完整流程：

```text
更新版本 → 本地构建 → 上传 MinIO → 创建版本记录 → 发布
→ 客户端检查 → 提示或静默下载 → 安装 → WGT 按策略重启
```

低代码平台必须支持：管理端鉴权、MinIO 上传与下载、版本查询、发布撤回和操作审计。

## 3. 后台管理功能

### 3.1 应用管理

- 新增、查询、修改、启停应用。
- 固定 `appKey`、App ID、applicationId；已有 APK 发布后不可直接修改身份字段。
- 展示当前已发布 APK/WGT、更新时间和异常文件数量。

### 3.2 文件管理

- 申请上传凭证，上传 APK/WGT，确认上传完成。
- 后台记录文件名、类型、大小、对象地址及发布人填写的版本信息；发布人负责确认文件与所选应用匹配。
- 状态：`UPLOADING`、`READY`、`DELETING`、`DELETED`。
- 仅 `READY` 文件可绑定版本；已绑定或已发布文件不可删除。
- 超时上传、孤儿文件及删除失败由定时任务重试和对账。

### 3.3 版本管理

- 新增、编辑、删除草稿，发布和撤回版本。
- 状态：`DRAFT`、`PUBLISHED`、`REVOKED`；`PUBLISHED` 对应原版 `stable_publish=true`。
- 每个 `appid + platform + package_type` 最多一个正式版本；发布新正式版本时，在同一事务内替换该类型原正式版本。
- 发布后包文件、版本和兼容范围不可修改；错误版本立即撤回，客户端不再获取，但已安装客户端不降级。
- 同一应用的 APK/WGT 共用一条全局 `version_name` 序列；数据库和发布事务必须保证 `(app_id, version_name)` 唯一。
- 新发布的 `version_name` 必须高于该应用全部 APK/WGT 历史版本，禁止同版本跨类型复用和版本倒退。
- APK 的 `version_code` 必须随 APK 正式版本递增；WGT 不依赖 `version_code` 做服务端决策。
- 发布 WGT 前必须存在正式 APK，且 `APK.version_name >= WGT.minApkVersionName`；否则该 WGT 没有可达的整包升级路径，禁止发布。

### 3.4 包类型与更新策略

包类型决定安装对象和返回码；更新策略只决定客户端交互，不参与候选选择。

| 包类型 | `type` | 返回码 | 客户端安装方式 |
| --- | --- | ---: | --- |
| APK 整包 | `native_app` | `102` | 下载后调用 `plus.runtime.install`，进入 Android 系统安装界面 |
| WGT 资源包 | `wgt` | `101` | 下载后调用 `plus.runtime.install`，按策略重启或下次启动生效 |

| 更新策略 | 字段组合 | APK | WGT | 客户端行为 |
| --- | --- | --- | --- | --- |
| 普通更新 | `is_mandatory=false`、`is_silently=false` | 支持 | 支持 | 显示弹窗，允许取消 |
| 强制更新 | `is_mandatory=true`、`is_silently=false` | 支持 | 支持 | 弹窗不可关闭，下载后立即进入安装 |
| 静默更新 | `is_mandatory=false`、`is_silently=true` | 禁止 | 支持 | 不显示弹窗，后台下载并安装，下次启动生效 |

发布时必须保证：

- APK 的 `is_silently` 固定为 `false`；
- `is_mandatory` 与 `is_silently` 不得同时为 `true`；
- 正式客户端只读取已发布版本，草稿和已撤回版本不下发；
- 强制和静默标记原样返回客户端，不改变 APK/WGT 候选选择结果；
- 不做用户级灰度；需要分批时按独立应用或环境发布。

## 4. 数据库设计

### 4.1 `upgrade_app` 应用表

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `app_key` | 客户端稳定标识，唯一，如 `warehouse-terminal` |
| `name` | 应用名称 |
| `uni_appid` | UniApp App ID，唯一 |
| `application_id` | Android 包名，唯一 |
| `enabled` | 是否提供更新服务 |
| `revision` | 乐观锁版本 |
| `created_at/updated_at` | 创建/更新时间 |

### 4.2 `upgrade_file` 文件表

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `app_id` | 所属应用 |
| `package_type` | `APK` / `WGT` |
| `bucket/object_key` | MinIO 对象定位；对象键唯一 |
| `original_name/content_type` | 原文件信息 |
| `size_bytes` | 上传完成时记录的对象大小 |
| `status` | 文件状态 |
| `expires_at` | 上传意图过期时间 |
| `retry_count/last_error` | 清理重试信息 |
| `created_by/created_at/verified_at/deleted_at` | 审计时间 |

### 4.3 `upgrade_release` 版本表

| 字段 | 说明 |
| --- | --- |
| `id/app_id/file_id` | 主键、应用、文件 |
| `package_type` | `APK` / `WGT`，必须与文件一致 |
| `version_name/version_code` | 展示版本和 Android 整数版本码；客户端更新判断以 `version_name` 为准 |
| `title/contents` | 更新标题、内容 |
| `mandatory/silent` | 后台存储的强制、静默策略；检查接口直接输出 `is_mandatory/is_silently`，APK 的静默值固定为 false |
| `minApkVersionName` | WGT 最低适配 APK 版本；APK 为空 |
| `status` | `DRAFT/PUBLISHED/REVOKED` |
| `published_at/published_by` | 发布信息 |
| `revoked_at/revoked_by/revoke_reason` | 撤回信息 |
| `revision/created_by/created_at/updated_at` | 并发控制与审计 |

### 4.4 `upgrade_audit_log` 审计表

记录应用身份修改、文件删除、版本发布/撤回等高风险操作：`operator_id`、`action`、`object_type`、`object_id`、`before_data`、`after_data`、`request_id`、`created_at`。

### 4.5 必要约束

- `app_key`、`uni_appid`、`application_id` 唯一。
- `(app_id, version_name)` 唯一，确保 APK/WGT 共用版本序列且不同包类型也不能使用相同版本。
- 文件和版本必须属于同一应用且包类型一致。
- 一个文件最多绑定一个版本。
- 每个 `(app_id, package_type)` 最多一个 `PUBLISHED` 版本；历史发布记录保留。
- 发布、撤回、删除使用 `revision` 防止并发覆盖。
- WGT 的 `minApkVersionName` 必填，APK 的 `minApkVersionName` 必须为空。
- 发布 WGT 时，当前正式 APK 的 `version_name` 必须不低于 WGT 的 `minApkVersionName`。
- APK 的 `silent` 必须为 `false`，任一版本的 `mandatory` 与 `silent` 不得同时为 `true`。

## 5. API 约定

- 前缀：`/api/v1`；JSON；时间使用 UTC ISO 8601。
- 管理接口必须登录并按角色授权；公开检查接口限流。写接口接受 `Idempotency-Key`。
- 成功：`{"code":"OK","message":"success","data":...,"requestId":"..."}`。
- 失败：`{"code":"VERSION_CONFLICT","message":"版本码已存在","details":{},"requestId":"..."}`。
- 列表 `data` 统一为 `{"items":[],"page":1,"pageSize":20,"total":0}`，`pageSize` 最大 100。

常用错误码：`INVALID_ARGUMENT`、`UNAUTHORIZED`、`FORBIDDEN`、`NOT_FOUND`、`REVISION_CONFLICT`、`IDENTITY_MISMATCH`、`FILE_NOT_READY`、`VERSION_CONFLICT`、`RELEASE_NOT_COMPATIBLE`、`INVALID_UPDATE_POLICY`、`OBJECT_IN_USE`、`RATE_LIMITED`、`INTERNAL_ERROR`。检查更新接口兼容原版数字业务码：`0` 无更新、`101` WGT 更新、`102` APK 整包更新、负数表示无正式版本或参数错误。

## 6. 管理 API

### 6.1 应用

#### `POST /admin/apps`

请求：

```json
{
  "appKey": "warehouse-terminal",
  "name": "仓储作业终端",
  "uniAppid": "__UNI__EXAMPLE01",
  "applicationId": "com.example.warehouse"
}
```

返回：

```json
{"code":"OK","message":"success","data":{"id":"app_01","enabled":true,"revision":1},"requestId":"req_01"}
```

#### `GET /admin/apps?page=1&pageSize=20&enabled=true`

返回应用分页列表。`GET /admin/apps/{id}` 返回详情和当前 APK/WGT。

#### `PUT /admin/apps/{id}`

请求：`{"name":"仓储作业终端","enabled":true,"revision":1}`。返回新 `revision`。身份字段修改须专用高权限并保证没有已发布 APK。

#### `POST /admin/apps/{id}/enable`、`POST /admin/apps/{id}/disable`

请求：`{"revision":2,"reason":"现场系统停用"}`；返回 `enabled` 和新 `revision`。

### 6.2 文件

#### `POST /admin/files/upload-intents`

请求：

```json
{"appId":"app_01","packageType":"APK","fileName":"warehouse-terminal-1.1.0-101.apk","sizeBytes":30526568}
```

返回：

```json
{
  "code":"OK","message":"success","data":{
    "fileId":"file_01","objectKey":"apps/app_01/apk/file_01.apk",
    "uploadUrl":"https://minio.example/presigned","expiresAt":"2026-09-16T10:15:00Z"
  },"requestId":"req_02"
}
```

#### `POST /admin/files/{fileId}/complete`

上传完成后调用。服务端确认 MinIO 对象存在并记录实际大小，随后将文件状态置为 `READY`：

```json
{"code":"OK","message":"success","data":{"fileId":"file_01","status":"READY","sizeBytes":30526568},"requestId":"req_03"}
```

版本、应用身份和包类型由发布人在创建版本记录时填写并确认，本方案不解析或复验 APK/WGT 文件内容。

#### 其他文件接口

- `GET /admin/files?appId=&packageType=&status=&page=&pageSize=`：分页查询。
- `DELETE /admin/files/{id}?revision=1`：删除未绑定文件；返回 `DELETING`，后台删除对象后转 `DELETED`。

### 6.3 版本

#### `POST /admin/releases`

请求：

```json
{
  "appId":"app_01","fileId":"file_01","packageType":"APK",
  "versionName":"1.1.0","versionCode":101,
  "title":"功能更新","contents":"修复扫码和打印问题",
  "mandatory":false,"silent":false
}
```

WGT 额外填写：`"minApkVersionName":"1.1.0"`，用于判断当前整包版本是否可安装该 WGT。返回草稿 ID 和 `revision`。

#### `PUT /admin/releases/{id}`

仅修改草稿。请求示例：`{"title":"稳定性更新","contents":"修复已知问题","mandatory":false,"silent":true,"minApkVersionName":"1.1.0","revision":1}`。

#### `POST /admin/releases/{id}/publish`

请求：`{"revision":2,"publishAt":null}`。服务端原子确认文件为 `READY`、`versionName` 递增且 WGT 已填写 `minApkVersionName` 后发布。返回：

```json
{"code":"OK","message":"success","data":{"id":"rel_01","status":"PUBLISHED","publishedAt":"2026-09-16T10:30:00Z","revision":3},"requestId":"req_04"}
```

#### `POST /admin/releases/{id}/revoke`

请求：`{"revision":3,"reason":"发现启动崩溃"}`。立即停止下发并保留记录。

#### 其他版本接口

- `GET /admin/releases?appId=&packageType=&status=&page=&pageSize=`：分页查询。
- `GET /admin/releases/{id}`：详情。
- `DELETE /admin/releases/{id}?revision=1`：仅删除草稿，不删除文件。
- `GET /admin/audit-logs?objectType=&objectId=&page=&pageSize=`：审计查询。

## 7. 客户端 API

### 7.1 检查更新

#### `POST /app-updates/check`

请求：

```json
{
  "appid":"__UNI__EXAMPLE01",
  "packageName":"com.example.warehouse",
  "platform":"Android",
  "apkVersionName":"1.0.0",
  "wgtVersionName":"1.0.0"
}
```

本项目当前固定为 Android，但客户端仍提交 `platform`，且值固定为大小写一致的字符串 `Android`；服务端只接受该值并按 Android 正式版本查询。五个字段职责如下：

- `appid`：UniApp 应用身份，用于查找应用及其 APK/WGT 发布记录；
- `packageName`：当前安装 APK 的 Android applicationId，用于与应用登记的 `application_id` 做身份一致性校验，防止配置串用；
- `platform`：客户端平台，本项目固定为 `Android`；
- `apkVersionName`：当前安装 APK 的原生整包 `versionName`；
- `wgtVersionName`：当前实际生效的 UniApp 资源 `versionName`。

`appid + packageName` 唯一确定受管应用身份，`apkVersionName + wgtVersionName` 描述该设备当前的双版本状态。`appKey` 是管理后台的业务标识，不需要由客户端重复提交；`versionCode` 只用于 Android 覆盖安装，不参与更新检查。

无更新：

```json
{"code":0,"message":"当前版本已经是最新的，不需要更新","data":null,"requestId":"req_05"}
```

有更新时直接采用以下标准字段：

- `code=101` 且 `type="wgt"`：WGT 资源更新；
- `code=102` 且 `type="native_app"`：Android APK 整包更新；
- `is_mandatory`：是否强制更新；
- `is_silently`：是否静默更新，只允许 WGT 使用；
- `minApkVersionName`：仅 WGT 返回，表示最低适配 APK 版本。

客户端以 `type` 区分安装对象，以 `is_mandatory` 和 `is_silently` 决定交互策略。`code` 保留官方业务语义，用于判断无更新、WGT 更新、APK 更新及错误；响应不再增加与 `type` 重复表达更新类型的 `action` 或 `packageType` 字段。

APK 示例：

```json
{
  "code":102,
  "message":"整包更新",
  "data":{
    "releaseId":"rel_01","appid":"__UNI__EXAMPLE01","type":"native_app","version":"1.1.0",
    "title":"功能更新","contents":"修复扫码和打印问题","is_mandatory":false,"is_silently":false,
    "url":"https://minio.example/download/warehouse-terminal-1.1.0-101.apk",
    "minApkVersionName":null
  },"requestId":"req_06"
}
```

WGT 示例：

```json
{
  "code":101,
  "message":"wgt更新",
  "data":{
    "releaseId":"rel_02","appid":"__UNI__EXAMPLE01","type":"wgt","version":"1.1.1",
    "title":"资源更新","contents":"修复页面问题","is_mandatory":false,"is_silently":true,
    "url":"https://minio.example/download/warehouse-terminal-1.1.1.wgt",
    "minApkVersionName":"1.1.0"
  },"requestId":"req_07"
}
```

无更新使用 `code=0`。缺少正式版本或请求参数错误分别使用负数业务码；服务异常使用统一服务端错误码。

## 8. 更新决策

### 8.1 版本比较

版本比较参考原版 `uni-upgrade-center`：将版本按 `.` 分段，每段转为整数后从左到右比较；公共部分相等时，额外段只要存在大于零的值，该版本就更高。因此 `1.2` 与 `1.2.0` 相等，`1.2.0.1` 高于 `1.2`。

后台必须在录入和发布时限制为纯数字点分版本，避免原版比较函数将非数字段转换为 `NaN` 后产生错误结果。

### 8.2 精确判断流程

1. 客户端读取并提交 `appid`、`packageName`、`platform`、`apkVersionName` 和 `wgtVersionName`。本项目仅支持 Android，`platform` 固定为 `Android`。
2. 服务端先校验 `platform=Android`，再按 `appid` 查找启用应用，并校验请求中的 `packageName` 必须等于该应用登记的 Android `application_id`；平台非法或身份不匹配时返回错误，不查询或下发版本。
3. 服务端分别读取该应用当前 `PUBLISHED` 的 APK（`native_app`）和 WGT（`wgt`）；每种类型最多一条。两者均不存在时返回无正式版本。
4. 同时存在 APK 和 WGT 时，先比较二者的 `version`，选择版本较高者作为主候选；历史脏数据出现同版本时按官方行为选择 WGT。正常发布流程通过 `(app_id, version_name)` 唯一约束禁止同版本。
5. 仅存在一种包时，该包直接成为主候选。
6. 计算客户端有效版本 `effectiveVersion = max(apkVersionName, wgtVersionName)`。主候选必须满足 `candidate.version > apkVersionName` 且 `candidate.version > wgtVersionName`，等价于 `candidate.version > effectiveVersion`；否则返回 `code=0`。
7. 主候选是 APK 时，返回 `code=102`、`type=native_app`。
8. 主候选是 WGT 且 `minApkVersionName <= apkVersionName` 时，返回 `code=101`、`type=wgt`。
9. 主候选是 WGT 但 `minApkVersionName > apkVersionName` 时，不能直接下发 WGT，转而查找正式 APK。
10. 回退 APK 必须同时满足：
   - `APK.version > apkVersionName`；
   - `APK.version > wgtVersionName`，即不低于设备当前有效资源能力；
   - `APK.version >= WGT.minApkVersionName`，即安装后能够满足该 WGT 的最低原生壳要求。
11. 回退 APK 满足全部条件时返回 `code=102`、`type=native_app`；否则返回 `code=0`，并在管理后台提示“缺少可解锁该 WGT 的正式 APK”。
12. `is_mandatory` 和 `is_silently` 仅随候选记录返回并控制客户端交互，不参与候选选择。

等价伪代码：

```js
const apk = publishedNativeApp
const wgt = publishedWgt
const effectiveVersion = maxVersion(apkVersionName, wgtVersionName)

let candidate = null
if (apk && wgt) {
  candidate = compare(wgt.version, apk.version) >= 0 ? wgt : apk
} else {
  candidate = apk || wgt
}

if (!candidate) return noPublishedVersion()
if (compare(candidate.version, effectiveVersion) <= 0) return noUpdate()

if (candidate.type === 'native_app') {
  return apkUpdate(candidate) // code=102
}

if (compare(candidate.minApkVersionName, apkVersionName) <= 0) {
  return wgtUpdate(candidate) // code=101
}

if (
  apk &&
  compare(apk.version, apkVersionName) > 0 &&
  compare(apk.version, wgtVersionName) > 0 &&
  compare(apk.version, candidate.minApkVersionName) >= 0
) {
  return apkUpdate(apk) // code=102
}

return noUpdate()
```

### 8.3 与官方实现的差异

官方在 WGT 不兼容时，只检查回退 APK 是否高于当前 `apkVersionName`，没有确认该 APK 是否达到 WGT 的 `minApkVersionName`，也没有确认其高于当前 `wgtVersionName`。例如 WGT 为 `1.5.0`、`minApkVersionName=1.4.0`、正式 APK 为 `1.3.0`、客户端 APK 为 `1.2.0` 时，官方会下发仍无法解锁 WGT 的 APK `1.3.0`。

本方案保留官方“先选最高候选、再过双版本门槛、最后处理 WGT 兼容或回退 APK”的顺序，但通过以下两层规则修复该缺陷：

- 发布期：WGT 只有在存在 `APK.version >= WGT.minApkVersionName` 的正式 APK 时才允许发布；
- 运行期：回退 APK 必须同时高于 `apkVersionName`、`wgtVersionName`，并达到 WGT 的 `minApkVersionName`。


## 9. 最终端到端判断与客户端执行流程

本节是服务端与客户端实现时的唯一主流程。第 8 节定义候选算法，本节把请求、返回字段、包类型、更新策略、下载安装和异常处理串成完整闭环；实现不得另行引入“APK 固定优先”、按文件扩展名猜测类型或只看 HTTP 状态码的分支。

### 9.1 检查时机

- 冷启动进入首页后检查；也可在“检查更新”入口由用户主动触发。
- 同一进程只允许一个检查或下载任务，请求失败时提示用户稍后重试。
- 更新服务不可达时继续使用当前版本；强制更新弹窗一旦展示则不允许关闭。

### 9.2 最准确的完整流程

1. 客户端读取当前 `appid`、Android `packageName`、固定值 `platform=Android`、原生整包 `apkVersionName` 和实际生效资源 `wgtVersionName`，按 7.1 请求检查接口。
2. 服务端校验应用启用状态、`platform=Android`、App ID 与包名绑定关系，以及两个纯数字点分版本；平台非法、身份不匹配或参数错误时返回明确错误，不进入候选选择。
3. 服务端只读取 `PUBLISHED`（对应官方 `stable_publish=true`）的 Android APK 与 WGT，各类型最多一条。
4. 服务端按 8.2 选择唯一主候选：先比较正式 APK/WGT 的目标 `versionName`，再要求目标版本同时高于 `apkVersionName` 和 `wgtVersionName`。
5. 主候选为 WGT 时校验 `minApkVersionName <= apkVersionName`；不兼容时仅在正式 APK 同时满足升级价值和解锁条件时回退 APK，否则返回无更新。
6. 服务端只返回一种结果：无更新、APK 或 WGT；强制和静默只附着在已选候选上，不改变候选结果。
7. 客户端按官方响应语义处理：
   - `code=0`：无更新；
   - `code=101`：读取 `type=wgt` 的 WGT 更新数据并安装 WGT；
   - `code=102`：读取 `type=native_app` 的整包更新数据并安装 APK；
   - `code<0`：按接口错误提示，不下载安装。
8. 确定更新类型后，客户端只需读取 `is_mandatory`、`is_silently` 决定是否弹窗、是否允许取消和何时重启，不要求对多个重复类型字段做交叉校验。
9. 下载和安装在客户端本地完成。检查服务不接收安装结果回报，也不提供安装事件、下载地址刷新、摘要校验或启动后确认接口。

```text
读取 appid/packageName/platform=Android/apkVersionName/wgtVersionName
  -> 请求检查接口
  -> 校验 platform=Android、应用启用、App ID 与包名绑定、版本格式
  -> 读取正式 APK/WGT
  -> 选最高目标版本主候选
  -> 同时高于 apkVersionName 与 wgtVersionName？-- 否 --> code=0
  -> WGT？-- 否 --> code=102 / type=native_app
  -> minApkVersionName <= apkVersionName？-- 是 --> code=101 / type=wgt
  -> 有可升级且可解锁该 WGT 的 APK？-- 是 --> code=102 / type=native_app
                                      -- 否 --> code=0
  -> 客户端按 code/type 确定包类型
  -> 按 is_mandatory/is_silently 选择普通、强制或静默处理
  -> 本地下载并安装
```

### 9.3 客户端按类型和策略处理

客户端根据 `code` 确定检查结果：`101` 为 WGT，`102` 为 APK。随后按 `is_mandatory`、`is_silently` 决定交互；`type` 是更新记录自带的包类型字段，直接传给安装组件，不作为额外校验门槛。强制和静默是策略，不是包类型：

| 返回组合 | 客户端处理 |
| --- | --- |
| `code=0` | 不展示更新界面，继续运行当前版本 |
| `code=101`、`type=wgt`、普通 | 展示可关闭弹窗；确认后下载并安装 WGT；成功后提示重启 |
| `code=101`、`type=wgt`、强制 | 展示不可关闭弹窗；下载并安装 WGT；成功后自动重启 |
| `code=101`、`type=wgt`、静默 | 不展示弹窗；后台下载并安装 WGT；下次启动生效 |
| `code=102`、`type=native_app`、普通 | 展示可关闭弹窗；确认后下载 APK 并调起 Android 系统安装器 |
| `code=102`、`type=native_app`、强制 | 展示不可关闭弹窗；下载 APK 并调起 Android 系统安装器 |

后台发布规则保证 APK 不会静默，且强制与静默不会同时成立；客户端不需要为服务端合法响应增加重复字段交叉校验。

### 9.4 通用下载

1. 使用版本记录中的下载地址调用 `uni.downloadFile`。
2. 展示下载进度；非强制更新允许取消，下载成功后进入安装。
3. 下载失败或 HTTP 状态异常时提示重新下载。
4. 用户暂不安装时可保存已下载文件，下次检测到同版本时继续安装。

### 9.5 APK

- 普通更新可取消；强制更新隐藏取消入口。
- 下载完成后调用 `plus.runtime.install`，由 Android 系统安装界面继续处理。
- 系统禁止“安装未知应用”时给出设置引导；调用安装接口失败时提示重新下载或重试。
- APK 安装会离开当前应用进程，客户端交由 Android 系统安装器处理后续流程。

### 9.6 WGT

- 服务端根据 `minApkVersionName` 判断当前整包版本是否兼容，不兼容则不下发。
- 普通 WGT 提示用户；`is_silently=true` 时后台下载并调用 `plus.runtime.install`，下次启动生效。
- 非静默 WGT 安装成功后提示或自动调用 `plus.runtime.restart()`；安装失败时提示重新下载。

### 9.7 客户端状态

```text
IDLE → CHECKING → NONE
               → PROMPTING → DOWNLOADING → INSTALLING → RESTARTING
任一阶段失败 → 提示重试或返回 IDLE
```

## 10. 产物上传与发布生命周期

1. 在任意受信任的本地构建环境更新应用版本，并分别生成 APK 或 WGT。
2. 发布人确认应用、包类型、版本号和下载文件无误；系统校验新 `versionName` 高于该应用所有 APK/WGT 历史版本且没有跨类型重复。
3. 申请上传凭证并上传到 MinIO，调用完成接口后文件进入 `READY`。
4. 绑定文件创建版本草稿，填写版本号、更新说明、强制或静默策略；WGT 填写 `minApkVersionName`，且只有存在达到该版本的正式 APK 时才能发布。
5. 发布后客户端可见。发现坏包立即撤回，再发布更高版本修复；不向已安装设备降级。
6. 定时任务清理过期上传意图和未绑定孤儿文件，重试删除失败项，并每日核对数据库与 MinIO。
7. 数据库和 MinIO 均纳入备份恢复；恢复后必须重新对账，不得仅恢复其中一侧。

本地构建系统不属于升级中心，但应保证产物可安装、身份和版本填写正确。升级中心不依赖特定项目目录、脚本名称、构建工具或镜像版本。

## 11. 安全与运维

- 管理接口采用身份认证和最小权限；发布、撤回、删除单独授权并审计。
- MinIO 长期密钥只保存在服务端；客户端只接收版本记录对应的可访问下载地址。
- 文件上传完成时确认对象存在和大小；发布前由管理员确认应用、包类型和版本信息。
- 使用 HTTPS 保护检查、下载和管理接口；如需进一步防止存储内容被篡改，可另行增加摘要或离线签名校验。
- 日志禁止记录 MinIO 密钥、设备敏感信息和签名私钥。

## 12. 验收标准

- 多个应用的 App ID、applicationId、文件和版本序列完全隔离，后台不得跨应用绑定或下发文件。
- 新增第三个及后续应用无需修改表结构或客户端主流程。
- 仅 `READY` 文件可发布；同一应用的 APK/WGT 共用 `versionName` 序列，跨类型也不能重复，版本不能倒退。
- 每个 `appid + platform + type` 最多一个正式版本，替换过程必须原子完成。
- 发布 WGT 时必须存在版本达到其 `minApkVersionName` 的正式 APK；运行时回退 APK 也必须达到该要求。
- 发布、撤回和删除具备并发控制与审计记录；坏包撤回后不再下发。
- 更新检查可正确处理无更新、普通更新、强制更新、WGT 静默更新和 WGT `minApkVersionName` 不兼容。
- APK 与 WGT 同时存在时，先选版本较高者，再校验其同时高于 `apkVersionName` 和 `wgtVersionName`；历史同版本数据按官方行为选择 WGT。
- 客户端完成断网、弱网、磁盘不足、下载失败、安装取消、WGT 安装失败和进程重启测试。
- WGT 安装失败时应用仍能继续使用当前可运行资源。
- 过期上传、孤儿对象和删除失败可自动清理；数据库与 MinIO 对账、备份恢复可验证。
- 至少选择三个身份不同的测试应用，交叉执行构建、上传、发布和升级，确认无应用、文件或版本串用。