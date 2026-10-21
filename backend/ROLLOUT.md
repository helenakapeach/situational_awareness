# Supabase 生产环境与 MongoDB 临时沙箱

普通访问的所有业务操作继续使用 Supabase，`.github/workflows/deploy-pages.yml` 保持不变。只有显式添加 `?backend=mongo` 才会选择 FastAPI；API 出错时不会回退到 Supabase。两种模式的 Google 登录都由 Supabase Auth 处理。Mongo 模式的业务操作、成员检查、头像上传和管理功能只访问 MongoDB。

专用 Cloud Run 服务为 `linghang-main-app`，沙箱 API 默认地址是 `https://linghang-main-app-711094273715.us-east1.run.app`。本地可在根目录 `.env` 设置 `VITE_API_BASE_URL=http://localhost:26276`；该地址只在 `?backend=mongo` 时使用，URL 参数不能指定任意 API 地址。

## 每次 API 启动

1. 读取 `MONGODB_DATABASE`（默认 `linghang_main_app`），要求已配置的 `SUPABASE_DB_URL`，并连接支持事务的 Mongo replica set。
2. 在 `${MONGODB_DATABASE}_control.startup` 获取可续期的重置租约。新重置登记后，旧实例立即停止接受请求；并发重置会被拒绝，崩溃的重置可在租约到期后被替换。
3. 通过 `app/supabase_dump.py` 只读导出 PostgreSQL 快照，并用 GET 下载所引用的头像。导入前校验完整临时快照。不会修改 Supabase 表、RPC、策略、用户凭据或部署。
4. 导入名称为 `${MONGODB_DATABASE}_<random-generation>` 的全新空数据库，保留 ID、权限、关系、头像和 sequence 高水位，并验证导入内容。
5. 仅当当前进程仍持有未过期租约时，才原子地将代次标记为就绪。进程只服务自己的代次；随后按当前配置的命名空间和代次后缀删除旧代次，避免迟到请求或过期导入器修改新副本。

每次启动都会完整重置沙箱，包括本地 `--reload` 和 Cloud Run 冷启动。测试创建的帖子、投票、成员、编辑和文件都不会保留到下次启动。命名空间基础数据库（默认 `linghang_main_app`）不直接存放本次导入的数据；实际业务库为 `linghang_main_app_<random-generation>`，控制库为 `linghang_main_app_control`。清理仅删除当前命名空间的旧代次，其他应用数据库和 Supabase 生产数据不会被重置。更换命名空间后，旧命名空间的数据不会自动删除。代次数据库使用 16 位十六进制后缀，租约仍使用完整 32 位 UUID。默认代次库名共 34 字节，兼容 [Atlas Free 的 38 字节数据库名限制](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/#operational-limits)。短后缀发生碰撞时会拒绝启动，不会复用或覆盖已有数据库。

导出失败时，旧数据仍物理存在，但沙箱不可用。导入失败的代次不会发布，通常会被清理；清理失败或进程被强制终止可能留下未服务的代次，但验证通过前它不会成为活动代次。系统不会静默回退到旧来源快照。启动错误会包含失败步骤 `stage`；Mongo 操作失败还会提供 `mongo_code`，数据库名过长时提供 `reason=database_name_too_long`。原始驱动错误可能包含凭据，因此不直接输出。

每个 HTTP 请求都会检查共享代次标记。已退役实例（包括 `/health`）返回 503，不会提供部分导入的数据。部署重置时沙箱可能短暂不可用。Cloud Run 限制为一个实例，镜像运行一个 Uvicorn worker，以减少重复冷启动。除非有意互相退役，否则不要让多个本地进程共用一个沙箱集群。

## 配置与部署

运行时变量名见 `backend/.env.example`。可以复用现有 appointments Mongo 集群凭据，默认命名空间是 `linghang_main_app`，也可通过 `MONGODB_DATABASE` 配置其他名称。Mongo 连接字段可以参考 `~/gitSpot/linghang-appt/backend/.env` 中的连接配置；不要把实际凭据打印到终端、文档或提交中。应用需要自己的随机 `APP_SESSION_SECRET`；不再检查数据库名是否属于固定白名单。

`SUPABASE_DB_URL` 必须指向当前生产 Supabase 项目的 PostgreSQL direct/session-pooler 连接，并允许读取九张公开业务表、被引用的 `auth.users` 身份列、`storage.objects` 元数据和 identity sequence。可用时使用只读数据库角色。公开浏览器密钥权限不足。只有需要认证式头像 GET 下载时才配置 `SUPABASE_SERVICE_ROLE_KEY`；公开头像不需要服务端密钥。

部署脚本会在修改云资源或上传密钥前运行 `check-sandbox-config.py`，检查必需配置和 Mongo 连接字段，不限制数据库名称。镜像包含 PostgreSQL 驱动。凭据保留在私有 env 文件和独立 Secret Manager secret 中，不进入 Git 或前端变量。现有 Pages/Supabase 部署流程保持不变。

```sh
# 在 backend/.env 中配置运行时变量，默认使用 MONGODB_DATABASE=linghang_main_app。
uv run --project backend --extra migration python backend/scripts/check-sandbox-config.py --env-file backend/.env
PROJECT_ID=project-d65805f6-4709-4498-9df REGION=us-east1 \
  backend/scripts/deploy-cloud-run.sh
```

启动探针最多等待 240 秒完成重建。若数据超过启动时限，或导出期间头像发生变化或消失，启动会失败，需要重试；系统不会启用不完整的沙箱。SQL 导出使用单个 `REPEATABLE READ` 快照，Storage 文件则单独获取。此非生产发布期间，生产写入仍保持启用。

该流程会复制完整业务数据，包括私密资料字段和内容，但不复制 Auth 密码、会话或 refresh token。Mongo API 的成员和隐私规则仍然生效，并保留来源的 `is_admin`、`is_disabled` 和角色验证标记。沙箱业务写入不会调用来源数据库。浏览器业务缓存按 Mongo 模式隔离；主题设置和 Google 登录共用。

## 发布前验证

使用项目技能 `$backend-tests` 或执行 `bash .agents/skills/backend-tests/scripts/run.sh` 验证后端。它会用专用临时 MongoDB 8 replica set 与 PostgreSQL 17、动态 loopback 端口运行 `uv` lint 和完整 pytest，并在退出时清理容器；不会读取线上凭据或连接应用沙箱。后端测试覆盖真实 SQL 导出、从来源数据到启动导入再到 API 的重建、重复重置、自定义命名空间与跨命名空间清理隔离、并发租约、过期所有者发布保护和未就绪代次的 503 响应。默认 Supabase 选择、显式 Mongo 路由、OAuth 和深链参数及浏览器缓存隔离由 Node 测试验证；前端相关改动还需运行 `npm test` 和 `npm run build`。

本分支为发布审查准备代码，不会部署新版本、上传来源凭据、切换生产流量或导出生产数据。
