# Supabase production + disposable Mongo sandbox

Normal visits keep using Supabase for every business action. `.github/workflows/deploy-pages.yml` is unchanged. `?backend=mongo` explicitly selects the FastAPI adapter; an API failure never falls back to Supabase. Google login continues through Supabase Auth in both modes. Mongo actions, membership checks, uploads and moderation operate only on Mongo.

The dedicated Cloud Run service is `linghang-main-app`; default sandbox API origin is `https://linghang-main-app-711094273715.us-east1.run.app`. Local `.env` can override `VITE_API_BASE_URL=http://localhost:8000`, but that override is only used with `?backend=mongo`. No arbitrary API origin is accepted from URL parameters.

## Every backend startup

1. Require `MONGODB_DATABASE=linghang_main_app_sandbox` and a configured `SUPABASE_DB_URL`. Connect to a transaction-capable Mongo replica set.
2. Acquire a renewable reset lease in `linghang_main_app_sandbox_control.startup`. Old instances stop accepting requests as soon as the new reset claims that marker. Concurrent resets are rejected; a crashed reset can be replaced after its lease expires.
3. Export a read-only PostgreSQL snapshot and download referenced avatars using GET requests. Validate the complete temporary dump before importing. No Supabase table, RPC, policy, user credential or deployment is modified.
4. Import into a new, empty `linghang_main_app_sandbox_<random-generation>` database. Preserve IDs, source permissions, relationships, avatars and sequence highwaters. Verify the imported content.
5. Atomically mark that generation ready only if this process still owns an unexpired reset lease. The process serves exclusively its own generation. Then drop the retired generation, guarded by an exact sandbox-name pattern. Late requests from an old process and expired importers cannot modify the new copy.

The observable result is a full wipe/reset of sandbox data on every boot, including local `--reload` and Cloud Run cold starts. Test-created posts, votes, members, edits and files never survive into the next generation. The old `linghang_main_app` database, other applications' databases and Supabase production are never reset. Only a small control marker is retained between boots.

A failed export keeps the previous data physically intact but leaves the sandbox unavailable. A failed import is never published; its incomplete generation is removed when possible. Failed cleanup or a hard process kill can leave an unserved generation behind. It cannot become active without successful verified publication. No cache of an old source snapshot is silently served.

Each HTTP request checks the shared generation marker. Retired instances return 503, including `/health`; they cannot serve a partly imported database. A reset can briefly interrupt sandbox access during deployments. Cloud Run is limited to one instance and the image runs one Uvicorn worker, reducing repeated cold-start resets. Do not point multiple local processes at the same sandbox cluster unless intentional: starting either one retires the other.

## Configuration and deployment

Use `app/.env.example` for runtime names. The existing appointments Mongo cluster credentials may be reused, while business data is isolated by sandbox database names. `configure-from-linghang.py` defaults to that sandbox namespace and preserves any source DB/Storage credentials already configured. It never copies appointments business collections.

`SUPABASE_DB_URL` must identify the current production Supabase project's PostgreSQL direct/session-pooler connection and allow SELECT of the nine public tables, referenced `auth.users` identity columns, `storage.objects` metadata, and identity sequences. Use a read-only database role where available. The public browser key is insufficient. Optional `SUPABASE_SERVICE_ROLE_KEY` is used only for authenticated avatar GET downloads; public avatars need no server key.

The deploy helper runs `check-sandbox-config.py` before changing cloud resources or uploading secrets. It refuses a different Mongo namespace or missing source configuration. The image includes the PostgreSQL driver. Credentials stay in the private env file / dedicated Secret Manager secret, never in Git or frontend variables. Existing Pages/Supabase deployment commands stay unchanged.

```sh
uv sync --project app --locked --extra migration
uv run --project app --extra migration python app/scripts/configure-from-linghang.py
# Add SUPABASE_DB_URL to app/.env; keep MONGODB_DATABASE=linghang_main_app_sandbox.
PROJECT_ID=project-d65805f6-4709-4498-9df REGION=us-east1 \
  app/scripts/deploy-cloud-run.sh
```

The startup probe allows up to 240 seconds for rebuilding. If data exceeds the startup budget or avatars change/disappear during the export, startup fails and must be retried; it does not enable an incomplete sandbox. SQL uses one repeatable-read snapshot, while Storage files are fetched separately. Production writes remain enabled for this non-production rollout.

This is intentionally a full business-data copy, including private profile fields and content. Auth passwords, sessions and refresh tokens are excluded. Mongo API membership/privacy rules still apply, and source `is_admin`/`is_disabled`/verification flags are preserved. Sandbox business writes never call the source database. Browser business caches are namespaced for Mongo; theme and Google login remain shared.

## Review verification

Tests cover default Supabase selection, explicit Mongo routing, preserved OAuth/deep-link parameters, browser cache separation, real SQL export, complete source-to-startup-to-API rebuilding, repeated reset, wrong-target refusal, concurrent owners, expired-owner publication, and unavailable-generation 503 responses. Destructive startup tests require an explicit localhost-only `TEST_SANDBOX_MONGODB_URI`; CI provisions disposable Mongo and PostgreSQL containers.

This branch prepares the rollout for review. It does not deploy a new revision, upload source credentials, switch production traffic, or run a production-data export.
