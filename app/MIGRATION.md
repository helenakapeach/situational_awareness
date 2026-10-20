# Supabase → MongoDB dump / import

Entry point: `app/scripts/migrate-supabase-to-mongo.py`. Run from the repository root. Supabase Auth remains in Supabase; this tool exports nine business tables, referenced users' identity fields, identity-sequence highwaters and referenced confirmed avatar files.

Current rollout is a disposable sandbox, not a production cutover: each API startup automatically runs the exporter and importer into a fresh sandbox generation. Ordinary frontend visits remain Supabase. See [ROLLOUT.md](./ROLLOUT.md). The commands below remain available for offline dumps and manual inspection; they do not configure the running API's generation pointer.

## Configure

```sh
uv sync --project app --locked --extra migration
```

Add `SUPABASE_DB_URL` to the private `app/.env`. Use a PostgreSQL direct/session-pooler connection with permission to read `public` business tables, the necessary `auth.users` columns, `storage.objects` and identity sequences. The public Supabase anon/publishable key cannot export hidden author IDs or private profiles. See [`app/.env.migration.example`](./.env.migration.example) for names and connection format.

`SUPABASE_URL` identifies the source Storage origin. The current avatars bucket is public, so no extra key is needed to download referenced files. If using authenticated Storage downloads, configure `SUPABASE_SERVICE_ROLE_KEY` server-side. Do not put it in a `VITE_` variable. Target connection `MONGODB_URI` can reuse the existing private `app/.env`.

To use a separate configuration file, place `--env-file app/.env.migration` **before** the subcommand. Environment variables override the env file. The script never prints connection strings, passwords, private profile content or driver error bodies.

## 1. Export a new snapshot

```sh
uv run --project app --extra migration python app/scripts/migrate-supabase-to-mongo.py \
  export --output migration-dumps/snapshot-001
```

Export runs a read-only, repeatable-read PostgreSQL transaction. It does not write source rows or sequences. Avatar bytes are downloaded separately, so final-cutover exports require business writes/uploads to be frozen beforehand. The script does not automatically install a write-maintenance policy.

The output directory must not exist. A successful export atomically publishes this layout:

```text
migration-dumps/snapshot-001/
  manifest.json
  users.jsonl
  cohorts.jsonl
  invite_codes.jsonl
  members.jsonl
  profiles.jsonl
  posts.jsonl
  replies.jsonl
  post_votes.jsonl
  reply_votes.jsonl
  feedback.jsonl
  avatars/<original-random-name>.webp
```

The manifest records row counts, SHA-256 checksums, snapshot ID, avatar metadata and sequence highwaters. Directories are created with mode 0700 and files with 0600. Failed exports remove their own partial directory. `migration-dumps/` is ignored by Git and excluded from Docker/GCloud uploads. These files still contain private business data; store them as private backups.

Auth export selects only referenced user IDs, email, and name/avatar metadata. Password hashes, sessions and refresh tokens are never selected. Unused Auth users remain solely in Supabase and acquire a Mongo identity record on their next login.

## 2. Validate offline

```sh
uv run --project app python app/scripts/migrate-supabase-to-mongo.py \
  validate --input migration-dumps/snapshot-001
```

This needs no database connection. It validates checksums/counts, unique IDs, field types, source relations, same-post parent replies, avatar files and sequence bounds. Output contains counts and generic difference labels, never private field values.

## 3. Dry-run a fresh target namespace

```sh
uv run --project app python app/scripts/migrate-supabase-to-mongo.py \
  import --input migration-dumps/snapshot-001 --database linghang_main_app_import
```

Without `--apply`, the importer performs only validation and target reads: no records, indexes or migration marker are written. Always specify the database name explicitly.

Use a fresh namespace. The deployed `linghang_main_app` already contains startup cohorts/counters; it is therefore intentionally rejected as an unmarked nonempty target. There is no `--force`, drop or replace-database option. An existing namespace is resumable only when it has the same snapshot's `in_progress` marker.

## 4. Apply and verify

```sh
uv run --project app python app/scripts/migrate-supabase-to-mongo.py \
  import --input migration-dumps/snapshot-001 --database linghang_main_app_import --apply

uv run --project app python app/scripts/migrate-supabase-to-mongo.py \
  verify --input migration-dumps/snapshot-001 --database linghang_main_app_import
```

The importer upserts by original primary keys, keeps user UUIDs/content IDs/profile public IDs, maps `feedback.author_id` to `user_id`, fills member email, and discards obsolete `avatar_pending`. Numeric counters are at least the source sequence/record highwater, including IDs above the largest surviving record. Unused source identity sequences keep their first ID available.

A migration marker tracks `in_progress` and `complete`. A failed import can resume with the same dump. A completed import is verified without rewriting; if new application writes changed its data, the script refuses to overwrite it. Different snapshots cannot claim the same target. Do not run concurrent importers or serve app writes into a database being imported.

App startup refuses an incomplete migration. A completed migration skips default cohort seeding, preserving the source cohort records. Verification checks record keys/content, avatar hashes and counter bounds. A nonzero exit means validation/import/verification failed. Partial imports remain isolated in the target namespace and can be resumed.

## 5. Production stays on Supabase

Do not point the running sandbox API at a manual import namespace: its startup rejects any configured namespace other than `linghang_main_app_sandbox` and replaces served data on every boot. Use `?backend=mongo` to test the independent Mongo copy; normal visitors continue reading/writing Supabase. There is no dual write or synchronization back from the sandbox.

This command does not switch frontend configuration, change cloud secrets or delete source tables. A durable production migration would require a separately reviewed plan; it is outside the current disposable rollout.

## Tests

```sh
TEST_POSTGRES_URL='postgresql://postgres:migration-test-only@localhost:55432/postgres' \
TEST_MONGODB_URI='mongodb://localhost:27027/?replicaSet=rs0&directConnection=true' \
  uv run --project app --extra migration pytest app/tests -q
```

Use disposable test databases. PostgreSQL tests create/drop uniquely named databases and need `CREATEDB`; Mongo tests create/drop isolated `sa_test_*`/`sa_mig_*` namespaces. CI provisions its own PostgreSQL and Mongo containers. Tests cover a real SQL snapshot, privacy filtering, file integrity, failure cleanup, CLI dry-run/apply/verify, interrupted resume, completed-target protection and ID continuation through the normal Python service.
