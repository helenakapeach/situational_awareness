from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from pydantic import ValidationError

from app.config import Settings


def mongo_config(**values):
    return Settings(
        _env_file=None,
        _env_prefix="__TEST_CONFIG_",
        app_session_secret="test-only-independent-secret-1234567890",
        **values,
    )


def test_mongo_credentials_are_encoded_once_and_options_are_preserved():
    password = "p@ss:/?#%+带空 格"
    settings = mongo_config(
        mongodb_server="mongodb+srv://cluster.example.test",
        mongodb_username="user@example.test",
        mongodb_password=password,
        mongodb_app_name="linghang main app",
        mongodb_options={"retryWrites": True, "w": "majority", "connectTimeoutMS": 5000},
    )
    uri = urlsplit(settings.mongodb_uri)
    assert unquote(uri.username) == "user@example.test"
    assert unquote(uri.password) == password
    assert uri.hostname == "cluster.example.test"
    assert parse_qs(uri.query) == {
        "retryWrites": ["true"],
        "w": ["majority"],
        "connectTimeoutMS": ["5000"],
        "appName": ["linghang main app"],
    }
    assert password not in repr(settings)
    assert "mongodb_uri" not in settings.model_dump()


def test_local_mongo_can_connect_without_credentials():
    settings = mongo_config(
        mongodb_options={"replicaSet": "rs0", "directConnection": True},
    )
    uri = urlsplit(settings.mongodb_uri)
    assert settings.mongodb_database == "linghang_main_app"
    assert uri.username is None
    assert parse_qs(uri.query)["directConnection"] == ["true"]


@pytest.mark.parametrize(
    "values",
    [
        {"mongodb_server": "https://cluster.example.test"},
        {"mongodb_server": "mongodb://user:password@localhost:27017"},
        {"mongodb_server": "mongodb://localhost:27017/?retryWrites=true"},
        {"mongodb_server": "mongodb://localhost:27017/database"},
        {"mongodb_username": "user"},
        {"mongodb_password": "password"},
        {"mongodb_options": {"appName": "duplicate"}},
        {"mongodb_options": {"PASSWORD": "misplaced"}},
    ],
)
def test_invalid_or_mixed_mongo_configuration_is_rejected(values):
    with pytest.raises(ValidationError):
        mongo_config(**values)
