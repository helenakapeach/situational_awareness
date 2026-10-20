# Situational Awareness API

A separate **uv + FastAPI + Pydantic + MongoDB** non-production stack. Supabase remains the production database and Google Auth provider. Ordinary page visits keep the existing Supabase adapter, even if an API URL is configured. Only `?backend=mongo` opts into this disposable Mongo stack.

```text
UI → src/http-backend.js → FastAPI routes → BackendService → MongoDB
Google/Supabase Auth → verified identity exchange → independent app JWT
```

`sa_backend/models.py` validates request fields; `main.py` handles HTTP; `services.py` contains membership, privacy, CRUD, votes and moderation. Business methods have no DOM or browser dependencies. Sync PyMongo runs in FastAPI's worker pool. MongoDB is the only business-data store in API mode.

## Run locally

Requirements: Python 3.12+, uv, Docker (or an existing MongoDB replica set).

```sh
cd app
uv sync --locked --extra migration
cp .env.example .env
openssl rand -hex 32
# Put the generated value in APP_SESSION_SECRET in app/.env.
# Set SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY to the existing Google Auth project.
# Set SUPABASE_DB_URL to its PostgreSQL direct/session-pooler connection.
# Keep MONGODB_DATABASE=linghang_main_app_sandbox (other targets are rejected).
docker compose up -d --wait
uv run --extra migration uvicorn sa_backend.main:create_app --factory --workers 1 --reload --port 8000
```

MongoDB **must support transactions**: use the local single-node replica set above or MongoDB Atlas. A standalone `mongod` is rejected at startup. The local container binds port 27017 to loopback and is for development only. Use authenticated TLS MongoDB for deployment; do not expose this development container to the internet. Transaction behavior follows the [PyMongo transaction API](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/crud/transactions/).

In the repository root `.env`, keep the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, and add:

```dotenv
VITE_API_BASE_URL=http://localhost:8000
```

Restart Vite. Open `http://localhost:5173/?backend=mongo` for the local API, or `http://localhost:5173/` for Supabase. `?demo=1` retains the browser demo. `VITE_API_BASE_URL` is only an opt-in API override; it never switches ordinary visitors. Without an override, `?backend=mongo` uses the dedicated `linghang-main-app` sandbox URL. OAuth redirects and copied post links retain the Mongo parameter. Mongo drafts, unread markers and target-post storage use separate browser keys; the theme and Supabase login stay shared.

The API docs are at `http://localhost:8000/docs`; `/health` requires a verified ready generation and Mongo connectivity. See [ROLLOUT.md](./ROLLOUT.md) for startup behavior, reset isolation and deployment prerequisites.

## Authentication

This follows `~/gitSpot/linghang-appt/backend/app/core/auth.py`'s `create_app_session_token` / `verify_app_session_token` pattern: verify the external identity, issue an HS256 application JWT with `sub`, `email`, `iat`, `exp`, `iss`, `aud` and `typ`, and accept it through a Bearer header. The issuer, token type, audience and secret are independent from linghang-appt. Its tokens are not accepted here.

- `POST /api/auth/session` with `{ "provider": "supabase", "access_token": "..." }` verifies the token against the configured Supabase `/auth/v1/user`, requires Google sign-in and a confirmed email, and returns `{ accessToken, tokenType, expiresIn, user }`.
- Optional Auth0 exchange accepts `{ "provider": "auth0", "idToken": "...", "nonce": "..." }`. Configure `AUTH0_DOMAIN` and `AUTH0_CLIENT_ID`; RS256 signature/JWKS, issuer, audience, expiration, Google connection, verified email and supplied nonce are checked. This is an API integration point; the existing UI still initiates Google through Supabase.
- `GET /api/auth/me` returns the authenticated user, not membership privileges.

The browser stores the app token in memory and re-exchanges when it expires or Supabase refreshes its session. Signing out clears that cache and signs out of Supabase. A previously copied app token remains valid until expiry; there is no token revocation list. Membership, admin and disabled status are read from MongoDB per action, so disabling a member blocks protected business operations without waiting for JWT expiry.

There is no endpoint that signs tokens from an arbitrary email/user ID and no development-auth bypass. Keep `APP_SESSION_SECRET` server-side and generate a random secret (at least 32 characters). Only publishable Supabase credentials belong in frontend `VITE_` variables.

## Operator setup

First sign in to create the user identity. Create an invitation using the operator CLI, then redeem it in the UI. Grant administrator access only after membership exists:

```sh
cd app
uv run python -m sa_backend.admin create-invite YOUR-CODE --max-uses 50
uv run python -m sa_backend.admin grant-admin admin@example.com
```

Startup imports source members, invites, profiles and cohorts instead of seeding replacements. Operator commands resolve the currently ready sandbox generation; their changes are discarded on the next startup. They require direct Mongo access and do not expose privilege-granting HTTP routes.

## Existing action → HTTP mapping

All 23 currently used data methods have Mongo implementations. The legacy unused `isMember` maps to the caller's membership status in the HTTP adapter. `getPost` is an additional direct-detail endpoint.

| Existing method | Endpoint |
|---|---|
| memberAccess / isMember | GET `/api/member-access` |
| redeemInviteCode | POST `/api/invite-redemptions` |
| getOwnProfile / updateOwnProfile | GET / PUT `/api/profile` |
| getProfile | GET `/api/profiles/{public_id}` |
| listCohorts | GET `/api/cohorts` |
| uploadAvatar / clearAvatar | POST / DELETE `/api/profile/avatar` |
| listPosts / createPost | GET / POST `/api/posts` |
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

`GET /api/posts` returns the existing array shape; subsequent pages pass `before` (timezone-aware ISO time) and `before_id`. All content IDs stay numeric for current UI compatibility. Writes allow only explicit request fields; author identity, ownership, counters and verified status cannot be supplied by normal clients. Anonymous content never exposes the author's internal ID/public profile. `is_op` is true only for the same author with matching anonymity. Public profile cards expose only opted-in contact fields and hide disabled members. Named-content identities are read from the current profile, so profile/role changes appear on content without SQL triggers.

Avatar uploads accept only verified 256×256 WebP bytes up to 1 MB. MongoDB stores the bytes under random names and updates the profile atomically; replacement/reset deletes the previous upload. The public asset path mirrors the existing `displayAvatarUrl()` shape. Browser cropping stays in the UI. Delete-post cascades replies/votes; delete-reply keeps descendants and promotes its direct children to the top level, matching the SQL foreign key behavior. Vote totals are derived from vote records rather than stored counters.

## Tests

```sh
cd app
uv run pytest
uv run ruff check .
uv run ruff format --check .
# Include integration tests against a disposable replica set:
TEST_MONGODB_URI='mongodb://localhost:27017/?replicaSet=rs0&directConnection=true' uv run pytest
# Destructive startup tests require a separate explicit LOCAL-only test URI:
TEST_MONGODB_URI='mongodb://localhost:27017/?replicaSet=rs0&directConnection=true' \
TEST_SANDBOX_MONGODB_URI='mongodb://localhost:27017/?replicaSet=rs0&directConnection=true' \
TEST_POSTGRES_URL='postgresql://postgres:TEST_PASSWORD@localhost:55432/postgres' \
  uv run --extra migration pytest
# From repository root:
npm test
npm run build
```

Integration tests create randomly named `sa_test_*` databases and drop those databases afterwards. Without `TEST_MONGODB_URI`, the real-Mongo tests are explicitly skipped; JWT/model tests still run. External OAuth verification is mocked in automated tests; testing a real Google redirect requires your configured project.

## Migration scope

Each real API startup bulk-copies the nine Supabase business tables, referenced users' minimal identity fields, confirmed avatars and numeric sequence highwaters. Export is read-only and no Mongo action writes back to Supabase. All sandbox changes are discarded at the next startup. Auth passwords, sessions and refresh tokens remain solely in Supabase. This intentionally copies full business rows, including private contact fields, into the sandbox; normal API privacy checks still apply.

Notifications, read markers, milestones, drafts and the loaded-feed search keep their current browser behavior. The new `getPost` API is available for direct clients; the UI retains its legacy deep-link navigation to preserve behavior across both backends. SQL RPCs such as `own_content_ids`, `op_reply_ids` and profile identity triggers become service rules, not generic RPC proxy endpoints.

The frontend Supabase data SDK is confined to `src/backend.js`. The HTTP adapter receives only `supabase.auth`, so it cannot use the data client's `.from()`, `.rpc()` or `.storage` methods. `test/data-access-boundary.test.js` guards application source against new SDK imports, direct Supabase REST URLs, RPC and Storage calls outside that file. The existing Pages CI runs this through `npm test`. Auth calls and public-avatar URL construction are intentionally permitted.

## Cloud Run: linghang-main-app

Deployment follows `~/gitSpot/linghang-appt/backend/scripts/deploy-cloud-run.sh`: the existing gcloud login and project/region are reused; a dedicated runtime service account is created for this app; runtime configuration is stored in a separate `linghang-main-app-env` Secret Manager secret mounted at `/secrets/.env`.

```sh
# From the repository root. Source credential values are never printed.
uv run --project app python app/scripts/configure-from-linghang.py
# Reuses the appointments Mongo cluster/credentials but isolates app collections.
# Defaults to sandbox namespace linghang_main_app_sandbox; generates its own JWT secret.
# Set SUPABASE_DB_URL in app/.env before deploying.
PROJECT_ID=project-d65805f6-4709-4498-9df \
  REGION=us-east1 app/scripts/deploy-cloud-run.sh
```

The configuration helper inherits the source project's Auth0 settings. Supabase Auth settings can be supplied through the root frontend `.env` or the private `app/.env`. Re-running the helper preserves the existing app JWT secret. It does not reuse appointment business collections or configure the appointment system's Scheduler jobs.

`app/.env` is ignored by Git, Docker and the GCloud source uploader. Credentials are uploaded directly to Secret Manager, not baked into the image. Public API invocation is enabled at Cloud Run's IAM layer because Google sign-in/token exchange must be reachable; protected business routes still require the app JWT and Mongo membership checks.

The existing GitHub Pages workflow is unchanged. `?backend=mongo` targets `https://linghang-main-app-711094273715.us-east1.run.app` by default, so the production frontend build needs no new variable. That Cloud Run service is the independent Mongo sandbox created for this project. Deploying it does not switch normal visitors away from Supabase. The deploy helper validates sandbox settings before cloud changes, fixes maximum instances to one, and waits for `/health` after startup import. Every cold start, restart and local reload rebuilds the sandbox.

## Supabase / Python parity coverage

Before the parity work, the frontend suite covered pure helper functions, the HTTP adapter, design tokens and the source boundary; it did not test the production Supabase data adapter or execute Supabase SQL/RLS integration tests.

The shared `test/fixtures/backend-contract.json` now lists the 23 current data actions with their HTTP methods, paths and response kinds. The Node suite calls the real injectable `createSupabaseBackend()` against a scripted SDK transport, checking RPC/table payloads, query composition, result shaping, error propagation, missing-row handling and the three-stage avatar flow. The Python suite consumes the same manifest and executes all corresponding HTTP actions against a real transaction-capable MongoDB database. It also verifies privacy, ownership, OP-anonymity matching and reply promotion.

This establishes action-surface and observable behavior checks. It does **not** claim the mocked Supabase transport validates live PostgreSQL RLS, RPC bodies, triggers, OAuth consent or production data equivalence. Mongo integration tests and the backend CI use disposable `sa_test_*` databases; the application database is not used for test fixtures. The CI starts its own Mongo replica set and needs no cloud credentials.

Deployment target: service `linghang-main-app`, project `project-d65805f6-4709-4498-9df`, region `us-east1`. The previously deployed revision predates startup rebuilding; the rollout in this branch needs source database credentials and a new deployment after review. No production frontend switch is needed.

Read-only post-deployment verification:

```sh
uv run --project app python app/scripts/smoke-deployment.py \
  https://linghang-main-app-711094273715.us-east1.run.app
```

## Supabase → Mongo dump script

See [MIGRATION.md](./MIGRATION.md) for the generated export/validate/import/verify command. Import defaults to a read-only dry-run and requires an explicit fresh target database. Export needs the source Supabase PostgreSQL connection; no production export/import or frontend cutover is performed by generating this script.
