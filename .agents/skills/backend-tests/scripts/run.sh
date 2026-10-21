#!/usr/bin/env bash
# 为开发者重复执行完整后端检查；只清理本次创建的资源。
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo '用法：bash .agents/skills/backend-tests/scripts/run.sh'
  echo '需要 Docker、uv、Python 3.12+；使用独立临时数据库运行 lint 和完整后端测试。'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo '此脚本不接受数据库地址或其他参数。' >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../../../.." && pwd)"
command -v docker >/dev/null 2>&1 || { echo '请先安装并启动 Docker。' >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { echo '请先安装 uv。' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '无法连接 Docker，请确认它已启动。' >&2; exit 1; }

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sa-backend-tests.XXXXXX")"
RUN_NAME="$(basename -- "${RUN_DIR}")"
MONGO_NAME="${RUN_NAME}-mongo"
POSTGRES_NAME="${RUN_NAME}-postgres"
MONGO_CREATED=false
POSTGRES_CREATED=false
cleanup() {
  if [[ "${MONGO_CREATED}" == "true" ]]; then docker rm -f -v "${MONGO_NAME}" >/dev/null || true; fi
  if [[ "${POSTGRES_CREATED}" == "true" ]]; then docker rm -f -v "${POSTGRES_NAME}" >/dev/null || true; fi
  rm -rf -- "${RUN_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo '启动独立 MongoDB 副本集和 PostgreSQL 测试容器…'
docker run -d --name "${MONGO_NAME}" -p 127.0.0.1::27017 \
  mongo:8.0 --replSet rs0 --bind_ip_all >/dev/null
MONGO_CREATED=true
docker run -d --name "${POSTGRES_NAME}" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=local-test-only postgres:17 >/dev/null
POSTGRES_CREATED=true

wait_for() {
  local label="$1"
  shift
  for ((attempt = 0; attempt < 60; attempt++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "${label} 未能在 60 秒内就绪。" >&2
  return 1
}
wait_for MongoDB docker exec "${MONGO_NAME}" mongosh --quiet --eval 'db.runCommand({ping:1})'
docker exec "${MONGO_NAME}" mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})' >/dev/null
wait_for 'MongoDB 主节点' docker exec "${MONGO_NAME}" mongosh --quiet --eval \
  'quit(db.hello().isWritablePrimary ? 0 : 1)'
wait_for PostgreSQL docker exec "${POSTGRES_NAME}" pg_isready -h 127.0.0.1 -U postgres

MONGO_ADDRESS="$(docker port "${MONGO_NAME}" 27017/tcp)"
POSTGRES_ADDRESS="$(docker port "${POSTGRES_NAME}" 5432/tcp)"
export TEST_MONGODB_URI="mongodb://${MONGO_ADDRESS}/?replicaSet=rs0&directConnection=true"
export TEST_SANDBOX_MONGODB_URI="${TEST_MONGODB_URI}"
export TEST_POSTGRES_URL="postgresql://postgres:local-test-only@${POSTGRES_ADDRESS}/postgres"
# 覆盖应用设置，防止误读本地 .env 中的真实运行凭据。
export MONGODB_SERVER="mongodb://${MONGO_ADDRESS}"
export MONGODB_USERNAME=''
export MONGODB_PASSWORD=''
export MONGODB_APP_NAME=linghang-main-app-tests
export MONGODB_OPTIONS='{"replicaSet":"rs0","directConnection":true}'
export MONGODB_DATABASE=linghang_main_app
export APP_SESSION_SECRET=test-only-independent-secret-1234567890
export APP_SESSION_TTL_SECONDS=3600
export SUPABASE_URL=https://identity.example.test
export SUPABASE_PUBLISHABLE_KEY=test-publishable-key
export SUPABASE_DB_URL="${TEST_POSTGRES_URL}"
export SUPABASE_SERVICE_ROLE_KEY=''
export AUTH0_DOMAIN=''
export AUTH0_CLIENT_ID=''
export CORS_ORIGINS='["http://localhost:5173"]'

cd -- "${PROJECT_ROOT}"
uv sync --project backend --locked --extra migration
uv run --project backend --extra migration ruff check backend
uv run --project backend --extra migration ruff format --check backend
uv run --project backend --extra migration pytest backend/tests -ra
