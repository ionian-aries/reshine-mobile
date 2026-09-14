# 项目维护规则

## 适用范围

本文件适用于 `reshine-mobile` 目录及其全部子目录。

## 强制同步要求

`Android-APK离线构建PRD.md` 是本项目 online、local 双应用管理及 Android APK Docker 离线构建方案的唯一现行基准文档。

后续任何涉及以下内容的代码、配置、脚本或方案变更，都必须在同一次工作中同步全量检查并更新 `Android-APK离线构建PRD.md`：

- `online/` 或 `local/` 的应用定位、App ID、包名、版本、资源生成方式和发布流程；
- `android/` 模板、原生模块、权限、Manifest、AAR/JAR、Gradle 或签名逻辑；
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
- 每个应用的 `.env` 仅用于会编译进前端的公开地址配置；仓库只提交 `.env.example`，真实 `.env` 不提交，也不传入 Docker。
- `config.json` 包含 Android 普通配置及敏感值，不提交 Git；App Key 和签名密码不得迁移到 `.env`。
- keystore 固定保存在 `config/<project>/secrets/`，不提交 Git。
- Docker 构建命令不通过 `-e` 传递 App Key 或签名参数。