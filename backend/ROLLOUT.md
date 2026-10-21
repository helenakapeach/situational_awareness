# Supabase 生产环境与 MongoDB 测试环境

普通访问继续使用 Supabase，`.github/workflows/deploy-pages.yml` 保持不变。只有显式添加 `?backend=mongo` 才会选择 FastAPI。两种模式的 Google 登录都由 Supabase Auth 处理；Mongo 模式的业务读写只访问 MongoDB。

Cloud Run 服务名为 `linghang-main-app`。本地联调在根目录 `.env` 设置 `VITE_API_BASE_URL=http://localhost:26276`，然后访问 `http://localhost:5173/?backend=mongo`。不带该参数的前端访问继续走 Supabase。

## 每次 API 启动

1. 读取 `backend/.env`；Cloud Run 优先读取挂载的 `/secrets/.env`。目标数据库由 `MONGODB_DATABASE` 指定，默认 `linghang_main_app`。
2. 通过 `app.supabase_dump` 只读导出 Supabase PostgreSQL 快照，并下载引用的头像。
3. 校验临时快照后，直接清空整个目标数据库，包括未列入迁移范围的旧集合和索引。
4. 调用 `app.migration.import_bundle()`，将来源数据、头像、索引和计数器写入同一个数据库，并核对导入结果。
5. 导入完成后启动 API。临时 dump 文件自动删除。

业务数据直接保存在 `linghang_main_app`，例如 `linghang_main_app.users` 和 `linghang_main_app.posts`。每次启动都会覆盖上次 Mongo 测试数据，包括本地 `--reload`、重启和 Cloud Run 冷启动。流程不创建其他数据库，也不保留备份。

导出或校验失败时，启动中止，目标数据库尚未清空。清空后导入失败时，启动同样中止，下次启动会重新清空并导入。错误会提供失败步骤 `stage`；Mongo 错误另附 `mongo_code`，不输出可能含有凭据的原始驱动错误。

这是单进程测试流程。Cloud Run 使用一个实例、一个 Uvicorn worker；本地也只运行一个后端进程。启动重建期间 API 不可用。

## 配置与部署

运行时字段见 [backend/.env.example](./.env.example)。Mongo 连接使用 `MONGODB_SERVER`、`MONGODB_USERNAME`、`MONGODB_PASSWORD`、`MONGODB_APP_NAME` 和 `MONGODB_OPTIONS`。可以复用现有 Mongo 集群凭据，目标数据库为 `linghang_main_app`。

`SUPABASE_DB_URL` 需要读取九张业务表、被引用的 `auth.users` 身份字段、`storage.objects` 元数据和 identity sequence。公开的浏览器密钥不能替代 PostgreSQL 连接串。只有私有头像下载需要 `SUPABASE_SERVICE_ROLE_KEY`。这些字段和独立的 `APP_SESSION_SECRET` 只放在后端环境文件中。

在仓库根目录执行：

```sh
uv run --project backend --extra migration python backend/scripts/check-sandbox-config.py --env-file backend/.env
PROJECT_ID=project-d65805f6-4709-4498-9df REGION=us-east1 \
  backend/scripts/deploy-cloud-run.sh
```

部署脚本先校验配置，再将 `backend/.env` 同步到专用 Secret Manager secret，使用 `backend/Dockerfile` 构建并部署。运行时挂载 `/secrets/.env`，容器启动后执行上述重建流程。凭据不进入 Git、镜像或前端变量。

启动探针最多等待 240 秒。Supabase 导出始终只读，Mongo 修改不会同步回来源。用户密码、会话和 refresh token 保留在 Supabase；来源的成员、管理员、禁用和角色验证状态会复制到 Mongo。

## 验证

项目技能 `$backend-tests` 或 `bash .agents/skills/backend-tests/scripts/run.sh` 使用专用临时 MongoDB 与 PostgreSQL 运行检查。测试覆盖整个目标数据库覆盖、重复启动丢弃修改、其他数据库不受影响、失败诊断、再次启动恢复，以及真实 SQL 来源导入到 API 的完整流程。

前端变更还需运行 `npm test` 和 `npm run build`。本验证流程不部署服务，也不读取线上凭据。
