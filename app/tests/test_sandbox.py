import hashlib
import json
import os
import re
import shutil
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from pymongo import MongoClient
from pymongo.uri_parser import parse_uri
from test_migration import make_bundle
from test_supabase_dump import source_database as source_database_fixture  # noqa: F401

from sa_backend import main, sandbox
from sa_backend.auth import create_app_session_token
from sa_backend.config import Settings

SANDBOX_URI_ENV = "TEST_SANDBOX_MONGODB_URI"
LOCAL_MONGO_HOSTS = {"localhost", "127.0.0.1", "::1", "mongo", "mongodb"}
GENERATION_DATABASE = re.compile(rf"{re.escape(sandbox.SANDBOX_DATABASE)}_[0-9a-f]{{32}}\Z")


def _generation_databases(client):
    return [name for name in client.list_database_names() if GENERATION_DATABASE.fullmatch(name)]


@pytest.fixture
def sandbox_db():
    uri = os.environ.get(SANDBOX_URI_ENV)
    if not uri:
        pytest.skip(f"Set {SANDBOX_URI_ENV} to a disposable local replica set for sandbox integration tests")

    # This fixture can erase the fixed sandbox database, so refuse any URI that
    # points at Atlas or another non-local Mongo deployment.
    hosts = {host for host, _port in parse_uri(uri)["nodelist"]}
    if not hosts or not hosts <= LOCAL_MONGO_HOSTS:
        pytest.fail(f"{SANDBOX_URI_ENV} must point only to a local Mongo host")

    with MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=3000) as client:
        try:
            client.admin.command("ping")
        except Exception as exc:
            pytest.fail(f"{SANDBOX_URI_ENV} is configured but Mongo is unavailable: {type(exc).__name__}")
        db = client[sandbox.SANDBOX_DATABASE]
        for name in _generation_databases(client):
            client.drop_database(name)
        client[sandbox.CONTROL_DATABASE].startup.delete_many({})
        try:
            yield db
        finally:
            for name in _generation_databases(client):
                client.drop_database(name)
            client[sandbox.CONTROL_DATABASE].startup.delete_many({})


def _settings(database=sandbox.SANDBOX_DATABASE):
    return SimpleNamespace(
        mongodb_database=database,
        supabase_db_url=SecretStr("postgresql://readonly.example.test/db"),
        supabase_url="https://identity.example.test",
        supabase_service_role_key=SecretStr("test-storage-key"),
    )


def _mock_export(monkeypatch, source):
    def export(_database_url, output, **_kwargs):
        shutil.copytree(source, output)

    monkeypatch.setattr(sandbox, "export_from_postgres", export)


def _change_post_title(path, title):
    post_file = path / "posts.jsonl"
    rows = [json.loads(line) for line in post_file.read_text().splitlines()]
    rows[0]["title"] = title
    raw = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows).encode()
    post_file.write_bytes(raw)
    manifest_file = path / "manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["tables"]["posts"]["sha256"] = hashlib.sha256(raw).hexdigest()
    manifest_file.write_text(json.dumps(manifest))


def test_reset_publishes_fresh_database_and_removes_retired_generation(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)
    previous_generation = "a" * 32
    previous_name = sandbox.sandbox_database_name(previous_generation)
    previous_db = sandbox_db.client[previous_name]
    previous_db["leftover_unmanaged_collection"].insert_one({"value": "old deployment data"})
    sandbox_db.client[sandbox.CONTROL_DATABASE].startup.insert_one(
        {
            "_id": "startup",
            "owner": previous_generation,
            "status": "ready",
            "active_database": previous_name,
        }
    )

    generation = sandbox.reset_sandbox(sandbox_db, _settings())
    generation_db = sandbox_db.client[sandbox.sandbox_database_name(generation)]

    assert generation
    assert generation_db.posts.find_one({"id": 12})["title"] == "Hello"
    assert "leftover_unmanaged_collection" not in generation_db.list_collection_names()
    assert previous_name not in sandbox_db.client.list_database_names()
    assert sandbox.sandbox_ready(sandbox_db, generation)
    state = sandbox_db.client[sandbox.CONTROL_DATABASE].startup.find_one({"_id": "startup"})
    assert state["owner"] == generation
    assert state["status"] == "ready"
    assert state["active_database"] == generation_db.name


def test_repeated_reset_discards_sandbox_writes_and_uses_latest_snapshot(sandbox_db, tmp_path, monkeypatch):
    source1, *_ = make_bundle(tmp_path / "source-one")
    source2, *_ = make_bundle(tmp_path / "source-two")
    _change_post_title(source2, "Latest source")
    current_source = [source1]

    def export(_database_url, output, **_kwargs):
        shutil.copytree(current_source[0], output)

    monkeypatch.setattr(sandbox, "export_from_postgres", export)
    old_generation = sandbox.reset_sandbox(sandbox_db, _settings())
    old_db = sandbox_db.client[sandbox.sandbox_database_name(old_generation)]
    old_db.posts.update_one({"id": 12}, {"$set": {"title": "Edited by app"}})
    old_db["runtime_cache"].insert_one({"_id": "stale"})

    current_source[0] = source2
    generation = sandbox.reset_sandbox(sandbox_db, _settings())
    generation_db = sandbox_db.client[sandbox.sandbox_database_name(generation)]

    assert generation_db.posts.find_one({"id": 12})["title"] == "Latest source"
    assert "runtime_cache" not in generation_db.list_collection_names()
    assert old_db.name not in sandbox_db.client.list_database_names()
    assert generation != old_generation
    assert sandbox.sandbox_ready(sandbox_db, generation)


def test_invalid_snapshot_preserves_preexisting_active_generation(sandbox_db, tmp_path, monkeypatch):
    valid_source, *_ = make_bundle(tmp_path / "valid-source")
    _mock_export(monkeypatch, valid_source)
    previous_generation = sandbox.reset_sandbox(sandbox_db, _settings())
    previous_db = sandbox_db.client[sandbox.sandbox_database_name(previous_generation)]
    previous_db.posts.update_one({"id": 12}, {"$set": {"title": "keep existing"}})
    previous_db["unrelated"].insert_one({"_id": "keep"})

    invalid_source, *_ = make_bundle(tmp_path / "invalid-source")
    (invalid_source / "posts.jsonl").write_text("corrupt snapshot\n")
    _mock_export(monkeypatch, invalid_source)

    with pytest.raises(RuntimeError, match="Mongo sandbox startup failed"):
        sandbox.reset_sandbox(sandbox_db, _settings())

    assert previous_db.posts.find_one({"id": 12})["title"] == "keep existing"
    assert previous_db.unrelated.find_one({"_id": "keep"})
    assert previous_db.name in sandbox_db.client.list_database_names()
    state = sandbox_db.client[sandbox.CONTROL_DATABASE].startup.find_one({"_id": "startup"})
    assert state["status"] == "failed"
    assert state["active_database"] == previous_db.name


def test_reset_refuses_wrong_database_without_mutating_it(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)
    other = sandbox_db.client["sa_should_survive"]
    other["marker"].insert_one({"_id": "untouched"})
    try:
        with pytest.raises(RuntimeError, match="restricted to database"):
            sandbox.reset_sandbox(other, _settings())
        assert other.marker.find_one({"_id": "untouched"})
    finally:
        sandbox_db.client.drop_database(other.name)


def test_reset_refuses_concurrent_startup_reset(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    entered_export = threading.Event()
    release_export = threading.Event()

    def blocked_export(_database_url, output, **_kwargs):
        entered_export.set()
        assert release_export.wait(timeout=5)
        shutil.copytree(source, output)

    monkeypatch.setattr(sandbox, "export_from_postgres", blocked_export)
    outcome = []
    worker = threading.Thread(target=lambda: outcome.append(sandbox.reset_sandbox(sandbox_db, _settings())))
    worker.start()
    try:
        assert entered_export.wait(timeout=5)
        with pytest.raises(RuntimeError, match="Mongo sandbox startup failed"):
            sandbox.reset_sandbox(sandbox_db, _settings())
    finally:
        release_export.set()
        worker.join(timeout=10)

    assert not worker.is_alive()
    assert outcome and sandbox.sandbox_ready(sandbox_db, outcome[0])


def test_expired_owner_import_cannot_publish_or_contaminate_new_generation(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)
    original_import = sandbox.import_bundle
    first_import_started = threading.Event()
    release_first_import = threading.Event()
    import_lock = threading.Lock()
    import_number = [0]
    old_database_names = []

    def pause_first_import(db, bundle, *, apply):
        with import_lock:
            import_number[0] += 1
            this_import = import_number[0]
        if this_import == 1:
            old_database_names.append(db.name)
            first_import_started.set()
            assert release_first_import.wait(timeout=10)
        return original_import(db, bundle, apply=apply)

    monkeypatch.setattr(sandbox, "import_bundle", pause_first_import)
    first_result = []

    def run_first_reset():
        try:
            first_result.append(sandbox.reset_sandbox(sandbox_db, _settings()))
        except RuntimeError as exc:
            first_result.append(exc)

    worker = threading.Thread(target=run_first_reset)
    worker.start()
    try:
        assert first_import_started.wait(timeout=10)
        state = sandbox_db.client[sandbox.CONTROL_DATABASE].startup
        state.update_one(
            {"_id": "startup"},
            {"$set": {"lease_until": datetime.now(timezone.utc) - timedelta(seconds=1)}},
        )

        new_generation = sandbox.reset_sandbox(sandbox_db, _settings())
    finally:
        release_first_import.set()
        worker.join(timeout=15)

    assert not worker.is_alive()
    assert len(first_result) == 1 and isinstance(first_result[0], RuntimeError)
    state = sandbox_db.client[sandbox.CONTROL_DATABASE].startup.find_one({"_id": "startup"})
    assert state["owner"] == new_generation
    assert state["status"] == "ready"
    assert state["active_database"] == sandbox.sandbox_database_name(new_generation)
    assert sandbox.sandbox_ready(sandbox_db, new_generation)
    assert old_database_names[0] not in sandbox_db.client.list_database_names()
    active_db = sandbox_db.client[state["active_database"]]
    assert active_db.posts.find_one({"id": 12})["title"] == "Hello"


def test_real_source_startup_resets_data_served_by_api(
    sandbox_db,
    source_database_fixture,  # noqa: F811
    monkeypatch,
):
    psycopg, source_url = source_database_fixture
    settings = Settings(
        _env_file=None,
        mongodb_uri=os.environ[SANDBOX_URI_ENV],
        mongodb_database=sandbox.SANDBOX_DATABASE,
        app_session_secret=SecretStr("test-only-independent-secret-1234567890"),
        supabase_url="https://identity.example.test",
        supabase_publishable_key="test-publishable-key",
        supabase_db_url=SecretStr(source_url),
        supabase_service_role_key=SecretStr("test-storage-key"),
        cors_origins=["http://localhost:5173"],
    )
    monkeypatch.setattr(main, "get_settings", lambda: settings)

    original_export = sandbox.export_from_postgres
    avatar_http = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=b"RIFF\x04\x00\x00\x00WEBP")
        )
    )

    def export_with_mocked_storage(database_url, output, **kwargs):
        return original_export(database_url, output, http_client=avatar_http, **kwargs)

    monkeypatch.setattr(sandbox, "export_from_postgres", export_with_mocked_storage)
    user = {
        "id": "00000000-0000-4000-8000-000000000001",
        "email": "a@example.test",
        "user_metadata": {"name": "Ada"},
    }
    headers = {"Authorization": "Bearer " + create_app_session_token(user, settings)}
    with psycopg.connect(source_url) as connection:
        source_before = connection.execute("SELECT id, title, body FROM public.posts ORDER BY id").fetchall()

    try:
        with TestClient(main.create_app()) as first_api:
            first_generation = first_api.app.state.sandbox_generation
            first_database = sandbox.sandbox_database_name(first_generation)
            first_posts = first_api.get("/api/posts", headers=headers)
            assert first_posts.status_code == 200, first_posts.text
            assert [post["title"] for post in first_posts.json()] == ["A later question", "A useful question"]
            created = first_api.post(
                "/api/posts", headers=headers, json={"title": "Only in this generation", "body": "temporary"}
            )
            assert created.status_code == 201, created.text

        with TestClient(main.create_app()) as second_api:
            second_generation = second_api.app.state.sandbox_generation
            second_posts = second_api.get("/api/posts", headers=headers)
            assert second_posts.status_code == 200, second_posts.text
            assert [post["title"] for post in second_posts.json()] == [
                "A later question",
                "A useful question",
            ]

        assert second_generation != first_generation
        assert first_database not in sandbox_db.client.list_database_names()
        assert sandbox.sandbox_ready(sandbox_db, second_generation)
        with psycopg.connect(source_url) as connection:
            source_after = connection.execute(
                "SELECT id, title, body FROM public.posts ORDER BY id"
            ).fetchall()
        assert source_after == source_before
    finally:
        avatar_http.close()


def test_default_app_startup_resets_before_bootstrap(monkeypatch):
    events = []
    settings = SimpleNamespace(
        mongodb_uri="mongodb://local",
        mongodb_database=sandbox.SANDBOX_DATABASE,
        cors_origins=["http://localhost:5173"],
    )

    class FakeDb:
        name = sandbox.SANDBOX_DATABASE

    class FakeClient:
        admin = SimpleNamespace(command=lambda command: events.append("hello") or {"setName": "rs0"})

        def __getitem__(self, _name):
            return FakeDb()

        def close(self):
            events.append("close")

    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "MongoClient", lambda *_args, **_kwargs: FakeClient())
    monkeypatch.setattr(main, "reset_sandbox", lambda _db, _settings: events.append("reset") or "b" * 32)
    monkeypatch.setattr(main, "bootstrap_indexes", lambda _db: events.append("bootstrap"))

    with TestClient(main.create_app()):
        assert events == ["hello", "reset", "bootstrap"]
    assert events[-1] == "close"


def test_http_health_fails_closed_when_generation_is_no_longer_ready(monkeypatch):
    class FakeDb:
        pinged = False

        def command(self, _command):
            self.pinged = True

    db = FakeDb()
    monkeypatch.setattr(main, "bootstrap_indexes", lambda _db: None)
    monkeypatch.setattr(main, "sandbox_ready", lambda _db, _generation: False)

    with TestClient(main.create_app(db=db)) as client:
        client.app.state.sandbox_generation = "old-generation"
        response = client.get("/health")

    assert response.status_code == 503
    assert response.text == "Mongo sandbox is restarting"
    assert not db.pinged
