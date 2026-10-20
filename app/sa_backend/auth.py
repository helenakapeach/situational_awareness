"""Identity exchange → app JWT, following linghang-appt's session-token pattern.

Our issuer, audience, type and signing secret are intentionally independent.
Mutable membership/admin permissions are always loaded from Mongo, never JWT claims.
"""

import time
from functools import lru_cache

import httpx
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .models import SessionRequest

ISSUER = "situational-awareness"
AUDIENCE = "situational-awareness-api"
TOKEN_TYPE = "situational_awareness_app_session"
bearer = HTTPBearer(auto_error=False)


def create_app_session_token(user: dict, settings: Settings) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": ISSUER,
            "aud": AUDIENCE,
            "sub": user["id"],
            "email": user["email"],
            "iat": now,
            "exp": now + settings.app_session_ttl_seconds,
            "typ": TOKEN_TYPE,
        },
        settings.app_session_secret.get_secret_value(),
        algorithm="HS256",
    )


def verify_app_session_token(token: str, settings: Settings) -> dict:
    try:
        claims = jwt.decode(
            token,
            settings.app_session_secret.get_secret_value(),
            algorithms=["HS256"],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["sub", "email", "iat", "exp", "typ"]},
        )
        if claims["typ"] != TOKEN_TYPE or not claims["sub"] or not claims["email"]:
            raise jwt.InvalidTokenError("Invalid session type or identity")
        return claims
    except jwt.InvalidTokenError as exc:
        raise HTTPException(401, "Invalid or expired app session token") from exc


def current_claims(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    settings: Settings = Depends(get_settings),
) -> dict:
    if not credentials:
        raise HTTPException(401, "Bearer token required")
    return verify_app_session_token(credentials.credentials, settings)


@lru_cache(maxsize=4)
def jwks_client(domain: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"https://{domain}/.well-known/jwks.json", cache_keys=True)


def verify_identity(payload: SessionRequest, settings: Settings) -> dict:
    if payload.provider == "supabase":
        if not settings.supabase_url or not settings.supabase_publishable_key:
            raise HTTPException(503, "Supabase Auth is not configured")
        try:
            response = httpx.get(
                f"{settings.supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {payload.access_token}",
                    "apikey": settings.supabase_publishable_key,
                },
                timeout=10,
            )
            response.raise_for_status()
            identity = response.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(401, "Invalid Supabase access token") from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Identity provider unavailable") from exc
        if identity.get("app_metadata", {}).get("provider") != "google":
            raise HTTPException(403, "Google sign-in is required")
        if not identity.get("id") or not identity.get("email") or not identity.get("email_confirmed_at"):
            raise HTTPException(401, "Verified identity required")
        metadata = identity.get("user_metadata") or {}
        return {
            "id": identity["id"],
            "email": identity["email"].lower(),
            "user_metadata": {
                key: metadata[key]
                for key in ("name", "full_name", "avatar_url")
                if isinstance(metadata.get(key), str)
            },
        }

    if not settings.auth0_domain or not settings.auth0_client_id:
        raise HTTPException(503, "Auth0 is not configured")
    try:
        key = jwks_client(settings.auth0_domain).get_signing_key_from_jwt(payload.idToken)
        claims = jwt.decode(
            payload.idToken,
            key.key,
            algorithms=["RS256"],
            audience=settings.auth0_client_id,
            issuer=f"https://{settings.auth0_domain}/",
            options={"require": ["sub", "exp", "iat"]},
        )
        if not claims.get("email_verified") or not claims.get("email"):
            raise jwt.InvalidTokenError("Verified email required")
        if not str(claims["sub"]).startswith("google-oauth2|"):
            raise jwt.InvalidTokenError("Google sign-in is required")
        if payload.nonce and claims.get("nonce") != payload.nonce:
            raise jwt.InvalidTokenError("Nonce mismatch")
    except (jwt.PyJWTError, ValueError) as exc:
        raise HTTPException(401, "Invalid or expired Auth0 ID token") from exc
    return {
        "id": claims["sub"],
        "email": claims["email"].lower(),
        "user_metadata": {
            "full_name": claims.get("name", "Google 用户"),
            "avatar_url": claims.get("picture", ""),
        },
    }
