import time

import httpx
import jwt
import pytest
from fastapi import HTTPException

from sa_backend.auth import (
    AUDIENCE,
    ISSUER,
    TOKEN_TYPE,
    create_app_session_token,
    verify_app_session_token,
    verify_identity,
)
from sa_backend.config import Settings, get_settings
from sa_backend.models import SessionRequest


def test_app_token_has_expiry_type_and_independent_issuer():
    settings = get_settings()
    user = {"id": "identity-id", "email": "test@example.com"}
    token = create_app_session_token(user, settings)
    claims = verify_app_session_token(token, settings)
    assert claims["sub"] == user["id"]
    assert claims["iss"] == ISSUER
    assert claims["aud"] == AUDIENCE
    assert claims["typ"] == TOKEN_TYPE
    assert claims["exp"] - claims["iat"] == settings.app_session_ttl_seconds
    assert "is_admin" not in claims


@pytest.mark.parametrize(
    "change",
    [
        {"exp": 1},
        {"iss": "linghang-appt"},
        {"aud": "other-app"},
        {"typ": "linghang_app_session"},
        {"sub": ""},
        {"email": ""},
    ],
)
def test_invalid_token_rejected(change):
    settings = get_settings()
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "typ": TOKEN_TYPE,
        "sub": "u",
        "email": "a@b.test",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
    }
    claims.update(change)
    token = jwt.encode(claims, settings.app_session_secret.get_secret_value(), algorithm="HS256")
    with pytest.raises(HTTPException) as error:
        verify_app_session_token(token, settings)
    assert error.value.status_code == 401


def test_missing_expiration_and_bad_signature_rejected():
    settings = get_settings()
    token = jwt.encode(
        {"sub": "u", "email": "a@b.test", "iss": ISSUER, "aud": AUDIENCE},
        settings.app_session_secret.get_secret_value(),
        algorithm="HS256",
    )
    with pytest.raises(HTTPException):
        verify_app_session_token(token, settings)
    token = create_app_session_token({"id": "u", "email": "a@b.test"}, settings)
    other = Settings(app_session_secret="another-independent-secret-1234567890")
    with pytest.raises(HTTPException):
        verify_app_session_token(token, other)


def test_supabase_token_verified_remotely_not_trusted_from_payload(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={
                "id": "supabase-user",
                "email": "USER@EXAMPLE.COM",
                "email_confirmed_at": "2026-01-01",
                "app_metadata": {"provider": "google"},
                "user_metadata": {"full_name": "User", "custom_private_field": "must-not-copy"},
            },
        )

    monkeypatch.setattr("sa_backend.auth.httpx.get", get)
    user = verify_identity(SessionRequest(access_token="external-token"), get_settings())
    assert user["id"] == "supabase-user"
    assert user["email"] == "user@example.com"
    assert user["user_metadata"] == {"full_name": "User"}
    assert calls[0][1]["headers"]["Authorization"] == "Bearer external-token"


@pytest.mark.parametrize(
    "identity",
    [
        {"id": "u", "email": "a@b.test", "email_confirmed_at": "date", "app_metadata": {"provider": "email"}},
        {"id": "u", "email": "a@b.test", "app_metadata": {"provider": "google"}},
    ],
)
def test_unverified_or_non_google_supabase_identity_rejected(monkeypatch, identity):
    monkeypatch.setattr(
        "sa_backend.auth.httpx.get",
        lambda url, **kwargs: httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json=identity,
        ),
    )
    with pytest.raises(HTTPException):
        verify_identity(SessionRequest(access_token="external-token"), get_settings())


def test_auth0_exchange_checks_signature_audience_and_nonce(monkeypatch):
    from types import SimpleNamespace

    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = Settings(
        app_session_secret="test-only-independent-secret-1234567890",
        auth0_domain="tenant.auth0.com",
        auth0_client_id="client-id",
    )
    verifier = SimpleNamespace(get_signing_key_from_jwt=lambda token: SimpleNamespace(key=key.public_key()))
    monkeypatch.setattr("sa_backend.auth.jwks_client", lambda domain: verifier)
    claims = {
        "sub": "google-oauth2|person",
        "email": "PERSON@EXAMPLE.COM",
        "email_verified": True,
        "iss": "https://tenant.auth0.com/",
        "aud": "client-id",
        "nonce": "login-nonce",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    token = jwt.encode(claims, key, algorithm="RS256")
    user = verify_identity(SessionRequest(provider="auth0", idToken=token, nonce="login-nonce"), settings)
    assert user["id"] == claims["sub"]
    with pytest.raises(HTTPException):
        verify_identity(SessionRequest(provider="auth0", idToken=token, nonce="wrong"), settings)
    claims["sub"] = "auth0|password-user"
    token = jwt.encode(claims, key, algorithm="RS256")
    with pytest.raises(HTTPException):
        verify_identity(SessionRequest(provider="auth0", idToken=token), settings)
    claims["sub"] = "google-oauth2|person"
    claims["aud"] = "wrong-client"
    token = jwt.encode(claims, key, algorithm="RS256")
    with pytest.raises(HTTPException):
        verify_identity(SessionRequest(provider="auth0", idToken=token), settings)


def test_cloud_run_secret_file_is_used(monkeypatch, tmp_path):
    from sa_backend import config

    secret_file = tmp_path / "mounted.env"
    secret_file.write_text(
        'APP_SESSION_SECRET="mounted-test-secret-12345678901234567890"\nMONGODB_DATABASE="mounted-db"\n'
    )
    monkeypatch.delenv("APP_SESSION_SECRET")
    monkeypatch.delenv("MONGODB_DATABASE", raising=False)
    monkeypatch.setattr(config, "Path", lambda path: secret_file)
    config.get_settings.cache_clear()
    settings = config.get_settings()
    assert settings.mongodb_database == "mounted-db"
    assert settings.app_session_secret.get_secret_value().startswith("mounted-test-")
