# Supabase 数据到 MongoDB 沙箱的迁移

Supabase 仍负责生产数据和 Google 身份验证。API 每次启动时，`app/supabase_dump.py`、`migration.py` 与 `sandbox.py` 会将 Supabase 业务数据只读导出、校验并覆盖导入 `MONGODB_DATABASE` 指定的 MongoDB 数据库（默认 `linghang_main_app`）。此流程属于应用启动的一部分，不提供单独的迁移命令，也不会切换生产流量。普通页面访问仍使用 Supabase；只有 `?backend=mongo` 会选择沙箱 API。完整启动流程见 [ROLLOUT.md](./ROLLOUT.md)。

## 数据范围与映射

`app.migration` 负责快照进入 Mongo 的处理，主要入口如下：

- `load_bundle()`：读取 manifest、JSONL 和头像文件，检查路径、文件哈希与行数，并将带时区时间转换为 Mongo 使用的 UTC 毫秒时间。
- `validate_bundle()`：验证 ID、唯一性、字段类型、用户与内容关联、父回复所属帖子、头像引用和序列边界；限制用户镜像字段，拒绝身份凭据和不安全的 Mongo 字段名。
- `_normalized_docs()`：执行必要字段适配，包括反馈作者字段重命名、成员邮箱补齐和删除过时的头像待确认字段。
- `import_bundle()`：默认只做试运行；显式写入时按原主键 upsert，建立索引、保存头像、推进计数器，并记录 `in_progress` / `complete` 导入状态。同一快照可继续未完成导入，已完成快照重复执行只核对，不覆盖后续业务更改。
- `verify_bundle()`：只读核对记录主键、内容、头像哈希和计数器高水位，返回数量和差异类型，不输出私密字段内容。

这个模块不负责连接 Supabase 导出，也不负责清空数据库：来源导出由 `app.supabase_dump` 完成；启动时由 `app.sandbox` 导出并校验快照、清空整个目标数据库，再调用导入。

迁移包含九张业务表：`cohorts`、`invite_codes`、`members`、`profiles`、`posts`、`replies`、`post_votes`、`reply_votes` 和 `feedback`；并包含这些记录引用用户的最少身份字段、已确认的头像文件，以及 PostgreSQL identity sequence 的高水位。用户密码、会话、refresh token 和未被引用的 Auth 用户不会导出。

数据保持原有主键、用户 UUID、内容 ID、profile `public_id`、关系和权限标记。`feedback.author_id` 映射为 Mongo 的 `user_id`，成员记录补齐邮箱，过时的 `avatar_pending` 字段会丢弃。数字计数器至少推进到来源 sequence 与记录 ID 中较大的高水位，因此即使高 ID 记录已删除，也不会重复分配 ID。

每份临时导出都带有 `manifest.json`，其中记录行数、SHA-256 校验和、快照标识、头像元数据和 sequence 高水位。导出目录还包含各业务表、被引用用户的 JSONL 文件及所引用的头像。目录权限为 `0700`，文件为 `0600`；这些文件只用于本次导入，完成或失败后自动删除，不保留备份。导出使用 PostgreSQL `REPEATABLE READ` 事务，并通过 GET 下载头像；不会写入 Supabase 表、sequence 或 Storage。

## 校验、导入与恢复

导入前会校验 manifest、行数与校验和、ID 唯一性、字段类型、表间引用、同一帖子下的回复关系、头像文件完整性和 sequence 边界。校验通过后直接执行 `drop_database(MONGODB_DATABASE)`，清除所有集合和索引，然后将快照导入同一个数据库。导入后再次核对记录、头像哈希和计数器边界。

`migration_state` 集合记录 `in_progress` 或 `complete`，仅用于校验导入状态。API 等待启动导入完成后才接受请求。导入失败会导致启动失败；下次启动重新清空和导入。应用不创建额外数据库、不保留旧数据备份，也不把 Mongo 修改写回 Supabase。

手动部署前，在私有的 `backend/.env` 中按 [backend/.env.example](./.env.example) 配置 Supabase 来源、独立应用密钥和拆分后的 Mongo 连接字段。Mongo 字段为 `MONGODB_SERVER`、`MONGODB_USERNAME`、`MONGODB_PASSWORD`、`MONGODB_APP_NAME`、`MONGODB_OPTIONS`，目标数据库默认 `MONGODB_DATABASE=linghang_main_app`，可按环境配置，无固定名称限制。`SUPABASE_DB_URL` 需要读取九张业务表、被引用的 `auth.users` 身份列、`storage.objects` 元数据和 identity sequence；可用时应采用只读角色。公开的 Supabase 浏览器密钥不能替代数据库连接。当前公开头像可直接通过 GET 获取；只有需要认证式 Storage 下载时才配置服务端 `SUPABASE_SERVICE_ROLE_KEY`，绝不可放入 `VITE_` 变量。

部署检查脚本 `backend/scripts/check-sandbox-config.py` 会在部署前拒绝缺失的必需配置或无效的 Mongo 连接字段。`backend/scripts/sync-secret.sh` 与 `backend/scripts/deploy-cloud-run.sh` 分别同步独立的 Secret Manager 配置并部署服务。凭据只存放在私有环境文件和专用 Secret Manager secret 中，不写入 Git 或前端变量。复用现有 Mongo 集群时，业务数据只写入 `MONGODB_DATABASE` 指定的数据库。

## 验证

使用项目技能 `$backend-tests` 或执行 `bash .agents/skills/backend-tests/scripts/run.sh` 运行后端完整校验。该脚本会启动专用临时 MongoDB 8 replica set 与 PostgreSQL 17、使用动态 loopback 端口运行 `uv` lint 和完整 pytest，并在退出时清理容器。测试不会读取线上凭据或连接应用沙箱。前端相关改动还需运行 `npm test` 和 `npm run build`。
