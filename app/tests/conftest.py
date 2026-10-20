import os
from uuid import uuid4

import pytest
from pymongo import MongoClient

from sa_backend.config import get_settings
from sa_backend.services import bootstrap_indexes


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
    monkeypatch.setenv("APP_SESSION_SECRET", "test-only-independent-secret-1234567890")
    monkeypatch.setenv("SUPABASE_URL", "https://identity.example.test")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
