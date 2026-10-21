import json
import os
from urllib.parse import parse_qsl, unquote, urlsplit
from uuid import uuid4

import pytest
from pymongo import MongoClient

from app.config import get_settings
from app.database import bootstrap_indexes


def mongo_settings(uri):
    parsed = urlsplit(uri)
    options = dict(parse_qsl(parsed.query))
    return {
        "mongodb_server": f"{parsed.scheme}://{parsed.netloc.rsplit('@', 1)[-1]}",
        "mongodb_username": unquote(parsed.username or ""),
        "mongodb_password": unquote(parsed.password or ""),
        "mongodb_app_name": options.pop("appName", "linghang-main-app"),
        "mongodb_options": options,
    }


@pytest.fixture
def db():
    uri = os.environ.get("TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set TEST_MONGODB_URI to a disposable replica set to run Mongo integration tests")
    with MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=3000) as client:
        # Atlas shared tiers enforce a shorter database-name limit than local Mongo.
        database = client[f"sa_test_{uuid4().hex[:20]}"]
        try:
            bootstrap_indexes(database)
            yield database
        finally:
            client.drop_database(database.name)


@pytest.fixture(autouse=True)
def settings_env(monkeypatch):
    for key, value in mongo_settings(
        os.environ.get("TEST_MONGODB_URI", "mongodb://localhost:27017/?replicaSet=rs0&directConnection=true")
    ).items():
        monkeypatch.setenv(key.upper(), json.dumps(value) if isinstance(value, dict) else value)
    monkeypatch.setenv("APP_SESSION_SECRET", "test-only-independent-secret-1234567890")
    monkeypatch.setenv("SUPABASE_URL", "https://identity.example.test")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
