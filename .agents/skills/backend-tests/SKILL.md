---
name: backend-tests
description: 验证本项目 Python/Mongo 后端、Supabase 迁移和前后端 action 兼容性；适用于后端修改、合并 main 后补齐功能或开发者请求完整后端检查。只使用本地临时数据库，不负责部署或线上迁移。
---

# 后端验证

## 使用范围

这是本仓库的开发者验证流程，替代原有后端测试 workflow。修改 `backend/`、后端适配器、共享 action contract 或合并新增 backend action 后使用。只修改文档时无需启动数据库。

## 完整检查

在仓库根目录执行：

```sh
bash .agents/skills/backend-tests/scripts/run.sh
```

需要 Docker、uv 和 Python 3.12 或更新版本。脚本安装锁定依赖和 migration extra，运行 Ruff 与完整 pytest。它创建本次检查专用的 MongoDB 8.0 副本集、PostgreSQL 17，使用动态分配的本机回环端口，并在退出时删除自己的容器和临时数据。容器和端口不与开发用 `backend/compose.yaml` 共用。

脚本自行设置三个 `TEST_*` 数据库地址，并覆盖应用运行凭据为测试值；不要替换成线上 URI，不需要读取 `backend/.env`、gcloud 凭据或 Supabase 生产凭据。新增测试的数据库连接也必须来自这些测试地址。

如果变更涉及 `src/backend.js`、`src/http-backend.js`、共享 contract 或前端行为，再执行：

```sh
npm test
npm run build
```

## 修改后的重点核对

- 对照 `src/backend.js` 的 action 和 `test/fixtures/backend-contract.json`。新增 action 同步修改 HTTP adapter、FastAPI route、Python service 和两端 contract 测试，不能只让界面出现新按钮。
- 按 `supabase/migrations/` 中对应 SQL 核对权限、返回字段、排序、数量限制、匿名身份和错误行为。Node 的 Supabase mock 只覆盖 SDK 调用与结果组装，不能证明线上 SQL/RLS 正确。
- 默认访问始终走 Supabase，只有 `?backend=mongo` 走 API；Mongo 失败不能回退到 Supabase 业务写入。Google Auth 继续使用 Supabase。
- 启动重建验证应覆盖只读导出、完整数据校验、ID 延续、重复启动清空测试写入、过期导入进程无法启用旧副本，以及未就绪时返回 503。

## 结果与边界

报告实际执行的检查、通过/失败/跳过数量和未验证部分。缺少测试数据库而跳过集成测试，不等于完整后端验证通过。修复影响结果的问题后重跑相关检查；完整检查通过且没有新改动时无需反复运行。

本 skill 不执行部署、推送代码、复制线上凭据或重置已有数据库。若任务另有这些要求，沿用该任务授权，不从“验证后端”推导出额外操作。应用结构见 [backend/README.md](../../../backend/README.md)，启动重建规则见 [backend/ROLLOUT.md](../../../backend/ROLLOUT.md)。
