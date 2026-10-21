#!/usr/bin/env bash
# Adapted from linghang-appt/backend/scripts/deploy-cloud-run.sh.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Deploy linghang-main-app using the existing gcloud login.
Required: PROJECT_ID
Optional: REGION (us-east1), SERVICE_NAME (linghang-main-app),
ENV_FILE (backend/.env), SECRET_ID (SERVICE_NAME-env), SERVICE_ACCOUNT,
SYNC_SECRET (true), ENABLE_APIS (true),
MEMORY (512Mi), CPU (1), MIN_INSTANCES (0). Maximum instances is fixed at 1.
The env file is mounted from Secret Manager at /secrets/.env.
Every container startup rebuilds the configured Mongo namespace from Supabase.
Source DB credentials are required. The production Pages deployment is unchanged.
No appointment Scheduler jobs are copied or changed.
USAGE
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-us-east1}"
SERVICE_NAME="${SERVICE_NAME:-linghang-main-app}"
SECRET_ID="${SECRET_ID:-${SERVICE_NAME}-env}"
ENV_FILE="${ENV_FILE:-${BACKEND_DIR}/.env}"

command -v gcloud >/dev/null 2>&1 || { echo 'gcloud is required.' >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { echo 'uv is required for the configuration preflight.' >&2; exit 1; }
[[ -f "${ENV_FILE}" ]] || { echo 'Create backend/.env before deploying.' >&2; exit 1; }
[[ "${MAX_INSTANCES:-1}" == "1" ]] || { echo 'This disposable sandbox requires MAX_INSTANCES=1.' >&2; exit 1; }
uv run --project "${BACKEND_DIR}" --locked --extra migration python \
  "${SCRIPT_DIR}/check-sandbox-config.py" --env-file "${ENV_FILE}"

if [[ "${ENABLE_APIS:-true}" == "true" ]]; then
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com --project "${PROJECT_ID}" --quiet
fi

if [[ "${SYNC_SECRET:-true}" == "true" ]]; then
  PROJECT_ID="${PROJECT_ID}" REGION="${REGION}" SERVICE_NAME="${SERVICE_NAME}" \
    SECRET_ID="${SECRET_ID}" ENV_FILE="${ENV_FILE}" "${SCRIPT_DIR}/sync-secret.sh"
fi

RUNTIME_SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
if [[ -z "${RUNTIME_SERVICE_ACCOUNT}" ]]; then
  RUNTIME_SERVICE_ACCOUNT="${SERVICE_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" \
      --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${SERVICE_NAME}" --project "${PROJECT_ID}" \
      --display-name "${SERVICE_NAME} runtime" --quiet
  fi
fi
[[ -n "${RUNTIME_SERVICE_ACCOUNT}" ]] || { echo 'Set SERVICE_ACCOUNT explicitly.' >&2; exit 1; }

gcloud secrets add-iam-policy-binding "${SECRET_ID}" --project "${PROJECT_ID}" \
  --member "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" --role roles/secretmanager.secretAccessor \
  --condition=None --quiet >/dev/null

gcloud run deploy "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" \
  --platform managed --source "${BACKEND_DIR}" --port 26276 \
  --service-account "${RUNTIME_SERVICE_ACCOUNT}" \
  --memory "${MEMORY:-512Mi}" --cpu "${CPU:-1}" \
  --min-instances "${MIN_INSTANCES:-0}" --max-instances 1 --max 1 \
  --startup-probe 'httpGet.path=/health,httpGet.port=26276,periodSeconds=2,timeoutSeconds=2,failureThreshold=120' \
  --set-secrets "/secrets/.env=${SECRET_ID}:latest" \
  --allow-unauthenticated --quiet

gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" \
  --region "${REGION}" --format 'value(status.url)'
