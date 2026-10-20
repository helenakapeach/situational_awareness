# Supabase 数据到 MongoDB 沙箱的迁移

Supabase 仍负责生产数据和 Google 身份验证。API 每次启动时，`sa_backend/supabase_dump.py`、`migration.py` 与 `sandbox.py` 会将 Supabase 业务数据只读导出、校验并导入一个全新的 MongoDB 沙箱代次。此流程属于应用启动的一部分，不提供单独的迁移命令，也不会切换生产流量。普通页面访问仍使用 Supabase；只有 `?backend=mongo` 会选择沙箱 API。完整启动流程见 [ROLLOUT.md](./ROLLOUT.md)。

## 数据范围与映射

迁移包含九张业务表：`cohorts`、`invite_codes`、`members`、`profiles`、`posts`、`replies`、`post_votes`、`reply_votes` 和 `feedback`；并包含这些记录引用用户的最少身份字段、已确认的头像文件，以及 PostgreSQL identity sequence 的高水位。用户密码、会话、refresh token 和未被引用的 Auth 用户不会导出。

数据保持原有主键、用户 UUID、内容 ID、profile `public_id`、关系和权限标记。`feedback.author_id` 映射为 Mongo 的 `user_id`，成员记录补齐邮箱，过时的 `avatar_pending` 字段会丢弃。数字计数器至少推进到来源 sequence 与记录 ID 中较大的高水位，因此即使高 ID 记录已删除，也不会重复分配 ID。

每份临时导出都带有 `manifest.json`，其中记录行数、SHA-256 校验和、快照标识、头像元数据和 sequence 高水位。导出目录还包含各业务表、被引用用户的 JSONL 文件及所引用的头像。目录权限为 `0700`，文件为 `0600`；这些文件包含私密业务数据，必须按私有备份保护。导出使用 PostgreSQL `REPEATABLE READ` 事务，并通过 GET 下载头像；不会写入 Supabase 表、sequence 或 Storage。

## 校验、导入与恢复

导入前会校验 manifest、行数与校验和、ID 唯一性、字段类型、表间引用、同一帖子下的回复关系、头像文件完整性和 sequence 边界。只有校验完整的快照才会导入到名称匹配 `linghang_main_app_sandbox_<random-generation>` 的全新空数据库。导入后会再次核对记录、头像哈希和计数器边界。

导入标记记录 `in_progress` 或 `complete` 状态。未完成的代次不会对请求开放；失败的导入会尽力删除，进程被强制终止时可能留下未服务的代次，但它不能被当作已就绪数据。启动租约、单一发布步骤和精确沙箱名称检查可阻止旧实例或过期导入器发布内容。每次重启会创建新代次并丢弃旧沙箱数据；应用不会把写入同步回 Supabase。

手动部署前，在私有的 `app/.env` 中按 [app/.env.example](./.env.example) 配置 `SUPABASE_DB_URL`、`SUPABASE_URL`、`MONGODB_URI`、固定的 `MONGODB_DATABASE=linghang_main_app_sandbox` 和独立生成的 `APP_SESSION_SECRET`。`SUPABASE_DB_URL` 需要读取九张业务表、被引用的 `auth.users` 身份列、`storage.objects` 元数据和 identity sequence；可用时应采用只读角色。公开的 Supabase 浏览器密钥不能替代数据库连接。当前公开头像可直接通过 GET 获取；只有需要认证式 Storage 下载时才配置服务端 `SUPABASE_SERVICE_ROLE_KEY`，绝不可放入 `VITE_` 变量。

部署检查脚本 `app/scripts/check-sandbox-config.py` 会在部署前拒绝缺失来源配置或错误的 Mongo 命名空间。`app/scripts/sync-secret.sh` 与 `app/scripts/deploy-cloud-run.sh` 分别同步独立的 Secret Manager 配置并部署服务。凭据只存放在私有环境文件和专用 Secret Manager secret 中，不写入 Git 或前端变量。复用现有 Mongo 集群时，业务数据仍隔离在 `linghang_main_app_sandbox_*` 命名空间内。

## 验证

使用项目技能 `$backend-tests` 或执行 `bash .agents/skills/backend-tests/scripts/run.sh` 运行后端完整校验。该脚本会启动专用临时 MongoDB 8 replica set 与 PostgreSQL 17、使用动态 loopback 端口运行 `uv` lint 和完整 pytest，并在退出时清理容器。测试不会读取线上凭据或连接应用沙箱。前端相关改动还需运行 `npm test` 和 `npm run build`。
