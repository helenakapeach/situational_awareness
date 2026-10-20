# 讨论区后端

这是独立的 **uv + FastAPI + Pydantic + MongoDB** 非生产环境。Supabase 仍负责生产数据库和 Google Auth。普通页面访问继续使用现有 Supabase adapter，即使已配置 API 地址也不会切换；只有 `?backend=mongo` 才会选择临时 Mongo 沙箱。

```text
UI → src/http-backend.js → FastAPI routes → BackendService → MongoDB
Google/Supabase Auth → 验证身份交换 → 独立的应用 JWT
```

`app/models.py` 校验请求字段；`main.py` 处理 HTTP；`services.py` 实现成员权限、隐私、CRUD、投票和管理操作。业务方法不依赖 DOM 或浏览器。同步 PyMongo 在 FastAPI worker pool 中运行。API 模式下，MongoDB 是唯一业务数据存储。

## 目录与命名规则

```text
backend/                 # 后端项目根目录，放置依赖、配置和部署文件
  pyproject.toml
  uv.lock
  app/                   # Python 包，统一通过 app.* 导入
    __init__.py
    main.py              # FastAPI 入口与路由，提供 create_app 工厂
    config.py            # 运行时配置
    models.py            # Pydantic 请求模型
    services.py          # 业务操作
    supabase_dump.py     # 只读导出来源快照
    migration.py         # 校验快照、适配字段、导入和核对 Mongo
    sandbox.py           # 启动重建、租约及新旧沙箱代次切换
  tests/                 # 后端测试
  scripts/               # 可重复使用的部署工具
```

`backend` 表示仓库中的项目目录，不作为 Python 导入前缀；`app` 才是 Python 包名。从 `backend/` 工作目录启动 `app.main:create_app`，代码使用 `from app.services import BackendService`，包内使用相对导入。模块、函数和变量使用 `snake_case`，类使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。新增模块按职责命名，不再添加项目缩写前缀。

## 本地运行

需要 Python 3.12+、uv 和 Docker，或已有 MongoDB replica set。

```sh
cd backend
uv sync --locked --extra migration
cp .env.example .env
openssl rand -hex 32
# 将生成的值填入 backend/.env 的 APP_SESSION_SECRET。
# SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 使用现有 Google Auth 项目配置。
# SUPABASE_DB_URL 填入该项目的 PostgreSQL direct/session-pooler 连接。
# MONGODB_DATABASE 固定为 linghang_main_app_sandbox，其他目标会被拒绝。
docker compose up -d --wait
uv run --extra migration uvicorn app.main:create_app --factory --workers 1 --reload --port 8000
```

MongoDB **必须支持事务**：使用上述本地单节点 replica set 或 MongoDB Atlas。独立 `mongod` 会在启动时被拒绝。本地容器只绑定 loopback 端口 27017，仅用于开发。部署时使用启用认证和 TLS 的 MongoDB；不要将开发容器暴露到互联网。事务行为遵循 [PyMongo transaction API](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/crud/transactions/)。

在仓库根目录 `.env` 中保留现有的 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`，并添加：

```dotenv
VITE_API_BASE_URL=http://localhost:8000
```

重启 Vite。打开 `http://localhost:5173/?backend=mongo` 访问本地 API，或打开 `http://localhost:5173/` 使用 Supabase。`?demo=1` 仍启用浏览器演示模式。`VITE_API_BASE_URL` 只覆盖显式选择的 API 地址，不会切换普通访客；未设置时，`?backend=mongo` 使用专用的 `linghang-main-app` 沙箱地址。OAuth 跳转和复制的帖子链接会保留 Mongo 参数。Mongo 模式的草稿、未读标记和目标帖子使用独立浏览器存储键；主题与 Supabase 登录共用。

API 文档位于 `http://localhost:8000/docs`。`/health` 仅在当前代次验证就绪且 Mongo 可连接时成功。启动行为、重置隔离和部署前提见 [ROLLOUT.md](./ROLLOUT.md)。

## 身份验证

实现遵循 `~/gitSpot/linghang-appt/backend/app/core/auth.py` 的 `create_app_session_token` / `verify_app_session_token` 模式：验证外部身份后，签发 HS256 应用 JWT，包含 `sub`、`email`、`iat`、`exp`、`iss`、`aud` 和 `typ`，请求通过 Bearer header 携带。签发者、token 类型、audience 和密钥均独立于 linghang-appt，因此其 token 在本服务中无效。

- `POST /api/auth/session` 接收 `{ "provider": "supabase", "access_token": "..." }`，使用配置的 Supabase `/auth/v1/user` 验证 token，要求 Google 登录和已确认邮箱，并返回 `{ accessToken, tokenType, expiresIn, user }`。
- 可选 Auth0 交换接收 `{ "provider": "auth0", "idToken": "...", "nonce": "..." }`。配置 `AUTH0_DOMAIN` 和 `AUTH0_CLIENT_ID` 后，会验证 RS256 签名/JWKS、issuer、audience、过期时间、Google connection、已验证邮箱和传入的 nonce。这是 API 集成点；现有 UI 仍通过 Supabase 发起 Google 登录。
- `GET /api/auth/me` 返回已认证用户信息，不代表成员权限。

浏览器在内存中保存应用 token；token 过期或 Supabase 刷新 session 后会重新交换。退出登录会清除缓存并退出 Supabase。已复制的应用 token 会持续有效直到过期；系统没有 token 撤销列表。每次操作都会从 Mongo 读取成员、管理员和禁用状态，因此禁用成员后，其受保护业务操作会立即被阻止，无需等待 JWT 过期。

没有接受任意邮箱或用户 ID 并签发 token 的 endpoint，也没有开发身份验证绕过。`APP_SESSION_SECRET` 必须留在服务端并使用至少 32 个字符的随机值。前端 `VITE_` 变量只能放 Supabase publishable 凭据。

## 管理员初始化

先登录以创建用户身份。使用管理员 CLI 创建邀请，再在 UI 中兑换。只有成员记录存在后，才授予管理员权限：

```sh
cd backend
uv run python -m app.admin create-invite YOUR-CODE --max-uses 50
uv run python -m app.admin grant-admin admin@example.com
```

启动时会导入来源成员、邀请、资料和 cohort，不会创建替代数据。管理员命令会解析当前就绪的沙箱代次，其更改会在下次启动时丢弃。命令需要直接 Mongo 访问权限，不会开放可提升权限的 HTTP 路由。

## 现有操作到 HTTP 的映射

当前使用的 25 个数据方法都有 Mongo 实现。旧版未使用的 `isMember` 在 HTTP adapter 中映射为调用者成员状态。`getPost` 是额外的单帖详情 endpoint。

| 现有方法 | 接口 |
|---|---|
| memberAccess / isMember | GET `/api/member-access` |
| redeemInviteCode | POST `/api/invite-redemptions` |
| getOwnProfile / updateOwnProfile | GET / PUT `/api/profile` |
| getProfile | GET `/api/profiles/{public_id}` |
| listCohorts | GET `/api/cohorts` |
| uploadAvatar / clearAvatar | POST / DELETE `/api/profile/avatar` |
| listPosts / createPost | GET / POST `/api/posts` |
| searchPosts | GET `/api/posts/search?q=...` |
| listMine | GET `/api/me/content` |
| getPost / updatePost / deletePost | GET / PATCH / DELETE `/api/posts/{id}` |
| createReply | POST `/api/posts/{id}/replies` |
| updateReply / deleteReply | PATCH / DELETE `/api/replies/{id}` |
| togglePostVote / toggleReplyVote | POST `/api/posts/{id}/vote` / `/api/replies/{id}/vote` |
| listLiked | GET `/api/likes` |
| createFeedback | POST `/api/feedback` |
| adminMembers | GET `/api/admin/members` |
| adminSetDisabled | PATCH `/api/admin/members/{user_id}` |
| adminSetRoleVerified | PUT `/api/admin/members/{user_id}/role-verification` |
| adminDeleteContent | DELETE `/api/admin/content/{post\|reply}/{id}` |

`GET /api/posts` 返回现有数组结构；后续分页传入带时区的 ISO 时间 `before` 和 `before_id`。所有内容 ID 继续使用数字，以兼容当前 UI。写入仅允许明确列出的请求字段；普通客户端不能提交作者身份、所有权、计数器或角色验证状态。匿名内容不会暴露作者内部 ID 或公开资料。仅当回复作者与帖子作者相同且匿名状态也一致时，`is_op` 才为 true。公开资料卡只展示用户主动公开的联系方式，并隐藏已禁用成员。具名内容的身份信息从当前 profile 读取，因此资料或角色变更无需 SQL trigger 就会反映在内容上。

头像上传只接受已验证的 256×256 WebP，最大 1 MB。MongoDB 使用随机名称保存文件并原子更新 profile；替换或重置时会删除旧文件。公开资源路径遵循现有 `displayAvatarUrl()` 结构，浏览器裁切仍在 UI 中完成。删除帖子会级联删除回复和投票；删除回复会保留后代，并将其直接子回复提升到顶层，以匹配 SQL 外键行为。投票总数由投票记录计算，不保存冗余计数器。

## 验证

使用项目技能 `$backend-tests` 或运行 `bash .agents/skills/backend-tests/scripts/run.sh`。脚本创建专用临时 MongoDB 8 replica set 和 PostgreSQL 17，使用动态 loopback 端口运行 `uv` lint 与完整 pytest，并在退出时清理容器；不会读取线上凭据。前端改动还应运行 `npm test` 和 `npm run build`。

Mongo 集成测试使用随机命名的 `sa_test_*` 数据库，并在结束后删除。缺少临时测试数据库时，真实 Mongo 测试会明确跳过；JWT/model 测试仍会运行。自动化测试会 mock 外部 OAuth 验证。需要验证真实 Google 跳转时，使用已配置的项目。

## 迁移范围

每次真实 API 启动都会批量复制九张 Supabase 业务表、被引用用户的最少身份字段、已确认头像和数字序列高水位。导出只读，Mongo 操作不会写回 Supabase。下次启动会丢弃所有沙箱更改。Auth 密码、session 和 refresh token 始终只保存在 Supabase。此设计会将完整业务行（包括私密联系方式）复制到沙箱；API 的常规隐私检查仍然适用。

通知、已读标记、里程碑和草稿沿用现有浏览器行为。搜索会查询 Mongo 的所有帖子，返回标题/正文中最新的 50 条字面子串匹配，并补齐回复、投票和所有权状态。`listMine` 最多返回调用者的 100 条帖子和 100 条回复，包括匿名内容，但不暴露作者 ID。这两项操作要求成员有效，并与新增 Supabase `search_posts` / `my_content` RPC 行为一致。`getPost` API 可供直接客户端使用；UI 在两种后端仍沿用现有深链导航。SQL RPC `own_content_ids`、`op_reply_ids` 及 profile identity trigger 的规则由服务层实现。

Supabase 前端数据 SDK 仅位于 `src/backend.js`。HTTP adapter 只接收 `supabase.auth`，无法使用数据客户端的 `.from()`、`.rpc()` 或 `.storage` 方法。`test/data-access-boundary.test.js` 检查应用源码，防止在该文件以外新增 SDK import、直接 Supabase REST URL、RPC 或 Storage 调用。现有 Pages CI 通过 `npm test` 执行此检查。Auth 调用和公开头像 URL 构造是有意允许的。

## Cloud Run：linghang-main-app

部署方式遵循 `~/gitSpot/linghang-appt/backend/scripts/deploy-cloud-run.sh`：复用现有 gcloud 登录及项目/区域，为本应用创建专用运行时 service account，并将运行时配置保存到独立的 `linghang-main-app-env` Secret Manager secret，挂载在 `/secrets/.env`。

```sh
# 在 backend/.env 中配置所需凭据，不要打印或复制真实 secret 到文档。
uv run --project backend --extra migration python backend/scripts/check-sandbox-config.py --env-file backend/.env
PROJECT_ID=project-d65805f6-4709-4498-9df \
  REGION=us-east1 backend/scripts/deploy-cloud-run.sh
```

`backend/.env` 已从 Git、Docker 和 GCloud source uploader 排除。凭据会直接上传至 Secret Manager，不会写入镜像。Cloud Run IAM 允许公开调用 API，以便 Google 登录和 token 交换可达；受保护业务路由仍要求应用 JWT 和 Mongo 成员检查。

现有 GitHub Pages workflow 未更改。`?backend=mongo` 默认访问 `https://linghang-main-app-711094273715.us-east1.run.app`，生产前端构建不需要新增变量。该 Cloud Run 服务是本项目独立的 Mongo 沙箱。部署不会让普通访客离开 Supabase。部署脚本会在云端变更前检查沙箱配置，最大实例数固定为 1，并在启动导入后等待 `/health` 就绪。每次冷启动、重启和本地 reload 都会重建沙箱。

迁移和启动重建细节见 [MIGRATION.md](./MIGRATION.md) 与 [ROLLOUT.md](./ROLLOUT.md)。后端完整验证使用 `$backend-tests` 技能或对应的 `scripts/run.sh`；现有 Pages workflow 继续负责 `npm test`。
