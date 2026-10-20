#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Sync a local env file to Google Secret Manager without creating duplicate versions.

Required:
  PROJECT_ID   Google Cloud project id.

Optional:
  SECRET_ID    Secret Manager secret id. Defaults to SERVICE_NAME-env or linghang-main-app-env.
  SERVICE_NAME Cloud Run service name. Defaults to linghang-main-app.
  ENV_FILE     Env file to store as the secret payload. Defaults to ../.env.
  REGION       Secret replication location when creating the secret. Defaults to automatic.

Example:
  PROJECT_ID=my-project ENV_FILE=./.env ./scripts/sync-secret.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-linghang-main-app}"
SECRET_ID="${SECRET_ID:-${SERVICE_NAME}-env}"
ENV_FILE="${ENV_FILE:-${BACKEND_DIR}/.env}"
PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-automatic}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required but was not found on PATH." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  echo "Create it from backend/.env.example and set production values." >&2
  exit 1
fi

if ! gcloud secrets describe "${SECRET_ID}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  create_args=(secrets create "${SECRET_ID}" --project "${PROJECT_ID}")
  if [[ "${REGION}" == "automatic" ]]; then
    create_args+=(--replication-policy automatic)
  else
    create_args+=(--replication-policy user-managed --locations "${REGION}")
  fi
  gcloud "${create_args[@]}"
fi

latest_payload="$(mktemp)"
cleanup() {
  rm -f "${latest_payload}"
}
trap cleanup EXIT

if gcloud secrets versions access latest \
  --secret "${SECRET_ID}" \
  --project "${PROJECT_ID}" \
  >"${latest_payload}" 2>/dev/null; then
  if cmp -s "${ENV_FILE}" "${latest_payload}"; then
    echo "Secret ${SECRET_ID} is already up to date; no new version created."
    exit 0
  fi
fi

gcloud secrets versions add "${SECRET_ID}" \
  --project "${PROJECT_ID}" \
  --data-file "${ENV_FILE}"

echo "Secret ${SECRET_ID} updated with a new version."
