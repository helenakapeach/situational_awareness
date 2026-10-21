import hashlib
import json
import os
import shutil
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from conftest import mongo_settings
from fastapi.testclient import TestClient
from pydantic import SecretStr
from pymongo import MongoClient
from pymongo.errors import OperationFailure
from pymongo.uri_parser import parse_uri
from test_migration import make_bundle
from test_supabase_dump import source_database as source_database_fixture  # noqa: F401

from app import main, sandbox
from app.auth.service import create_app_session_token
from app.config import Settings

SANDBOX_URI_ENV = "TEST_SANDBOX_MONGODB_URI"
LOCAL_MONGO_HOSTS = {"localhost", "127.0.0.1", "::1", "mongo", "mongodb"}


@pytest.fixture
def sandbox_db():
    uri = os.environ.get(SANDBOX_URI_ENV)
    if not uri:
        pytest.skip(f"Set {SANDBOX_URI_ENV} to a disposable local replica set for startup reset tests")
    hosts = {host for host, _port in parse_uri(uri)["nodelist"]}
    if not hosts or not hosts <= LOCAL_MONGO_HOSTS:
        pytest.fail(f"{SANDBOX_URI_ENV} must point only to a local Mongo host")
    with MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=3000) as client:
        db = client[f"sa_reset_{uuid4().hex[:16]}"]
        try:
            yield db
        finally:
            client.drop_database(db.name)


def _settings(db):
    return SimpleNamespace(
        mongodb_database=db.name,
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


def test_reset_overwrites_the_entire_target_database(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)
    sandbox_db.users.insert_one({"id": "stale-user"})
    sandbox_db.unmanaged_collection.insert_one({"_id": "old deployment data"})
    result = sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    assert result["ok"] and result["applied"]
    assert sandbox_db.posts.find_one({"id": 12})["title"] == "Hello"
    assert sandbox_db.users.find_one({"id": "stale-user"}) is None
    assert "unmanaged_collection" not in sandbox_db.list_collection_names()
    assert sandbox_db.migration_state.find_one({"_id": "supabase-to-mongo"})["status"] == "complete"
    # Importing directly must not create a control database or any backup database.
    names = sandbox_db.client.list_database_names()
    assert not any(name.startswith(sandbox_db.name + "_") for name in names)


def test_repeated_reset_discards_changes_and_imports_latest_source(sandbox_db, tmp_path, monkeypatch):
    source1, *_ = make_bundle(tmp_path / "source-one")
    source2, *_ = make_bundle(tmp_path / "source-two")
    _change_post_title(source2, "Latest source")
    _mock_export(monkeypatch, source1)
    sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    sandbox_db.posts.update_one({"id": 12}, {"$set": {"title": "Edited by app"}})
    sandbox_db.runtime_cache.insert_one({"_id": "stale"})
    _mock_export(monkeypatch, source2)
    sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    assert sandbox_db.posts.find_one({"id": 12})["title"] == "Latest source"
    assert "runtime_cache" not in sandbox_db.list_collection_names()


def test_invalid_source_fails_before_database_is_wiped(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    (source / "posts.jsonl").write_text("corrupt snapshot\n")
    _mock_export(monkeypatch, source)
    sandbox_db.marker.insert_one({"_id": "existing"})
    with pytest.raises(RuntimeError, match="stage=validate_snapshot"):
        sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    assert sandbox_db.marker.find_one({"_id": "existing"})


def test_import_failure_reports_safe_context_and_next_reset_recovers(
    sandbox_db, tmp_path, monkeypatch, caplog
):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)

    def failed_import(db, *_args, **_kwargs):
        db.users.insert_one({"id": "partial-import"})
        raise OperationFailure("mongodb://private:private-password@host/private-data", code=8000)

    with monkeypatch.context() as scoped:
        scoped.setattr(sandbox, "import_bundle", failed_import)
        with pytest.raises(RuntimeError) as error:
            sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    output = str(error.value) + caplog.text
    assert "stage=import_snapshot" in output and "mongo_code=8000" in output
    assert "private-password" not in output and "private-data" not in output
    sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
    assert sandbox_db.users.find_one({"id": "partial-import"}) is None
    assert sandbox_db.migration_state.find_one({"_id": "supabase-to-mongo"})["status"] == "complete"


def test_reset_does_not_modify_another_database(sandbox_db, tmp_path, monkeypatch):
    source, *_ = make_bundle(tmp_path / "source")
    _mock_export(monkeypatch, source)
    other = sandbox_db.client[f"sa_other_{uuid4().hex[:16]}"]
    try:
        other.marker.insert_one({"_id": "untouched"})
        sandbox.reset_sandbox(sandbox_db, _settings(sandbox_db))
        assert other.marker.find_one({"_id": "untouched"})
    finally:
        sandbox_db.client.drop_database(other.name)


def test_real_source_startup_replaces_the_same_database_served_by_api(
    sandbox_db,
    source_database_fixture,  # noqa: F811
    monkeypatch,
):
    psycopg, source_url = source_database_fixture
    settings = Settings(
        _env_file=None,
        **mongo_settings(os.environ[SANDBOX_URI_ENV]),
        mongodb_database=sandbox_db.name,
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
            assert first_api.app.state.db.name == sandbox_db.name
            assert first_api.get("/health").status_code == 200
            assert (
                first_api.post(
                    "/api/posts", headers=headers, json={"title": "Temporary test post", "body": "temporary"}
                ).status_code
                == 201
            )
        with TestClient(main.create_app()) as second_api:
            assert second_api.app.state.db.name == sandbox_db.name
            response = second_api.get("/api/posts", headers=headers)
            assert response.status_code == 200, response.text
            assert [post["title"] for post in response.json()] == ["A later question", "A useful question"]
        with psycopg.connect(source_url) as connection:
            source_after = connection.execute(
                "SELECT id, title, body FROM public.posts ORDER BY id"
            ).fetchall()
        assert source_after == source_before
    finally:
        avatar_http.close()


@pytest.mark.parametrize("reset_fails", [False, True])
def test_startup_resets_before_serving_and_propagates_failure(monkeypatch, reset_fails):
    events = []
    settings = SimpleNamespace(
        mongodb_uri="mongodb://local",
        mongodb_database="linghang_main_app",
        cors_origins=["http://localhost:5173"],
    )

    class FakeClient:
        admin = SimpleNamespace(command=lambda command: events.append("hello") or {"setName": "rs0"})

        def __getitem__(self, name):
            return SimpleNamespace(name=name)

        def close(self):
            events.append("close")

    def reset(db, _settings):
        assert db.name == "linghang_main_app"
        events.append("reset")
        if reset_fails:
            raise RuntimeError("Import failed")

    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "MongoClient", lambda *_args, **_kwargs: FakeClient())
    monkeypatch.setattr(main, "reset_sandbox", reset)
    monkeypatch.setattr(main, "bootstrap_indexes", lambda _db: events.append("bootstrap"))
    if reset_fails:
        with pytest.raises(RuntimeError, match="Import failed"), TestClient(main.create_app()):
            pytest.fail("Startup must fail")
        assert events == ["hello", "reset", "close"]
    else:
        with TestClient(main.create_app()) as app:
            assert app.app.state.db.name == "linghang_main_app"
            assert events == ["hello", "reset", "bootstrap"]
        assert events[-1] == "close"
