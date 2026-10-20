from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = "mongodb://localhost:27017/?replicaSet=rs0"
    mongodb_database: str = "linghang_main_app_sandbox"
    app_session_secret: SecretStr
    app_session_ttl_seconds: int = Field(default=3600, ge=60, le=604800)
    cors_origins: list[str] = ["http://localhost:5173"]
    supabase_url: str = ""
    supabase_publishable_key: str = ""
    supabase_db_url: SecretStr = SecretStr("")
    supabase_service_role_key: SecretStr = SecretStr("")
    auth0_domain: str = ""
    auth0_client_id: str = ""

    @field_validator("app_session_secret")
    @classmethod
    def strong_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 32:
            raise ValueError("APP_SESSION_SECRET must contain at least 32 characters")
        return value

    @field_validator("supabase_url")
    @classmethod
    def trusted_supabase_url(cls, value: str) -> str:
        if value and not value.startswith("https://"):
            raise ValueError("SUPABASE_URL must use HTTPS")
        return value.rstrip("/")

    @field_validator("auth0_domain")
    @classmethod
    def domain_only(cls, value: str) -> str:
        if value and ("/" in value or ":" in value or not value.strip() == value):
            raise ValueError("AUTH0_DOMAIN must be a hostname")
        return value


@lru_cache
def get_settings() -> Settings:
    # Same secret-file mount used by linghang-appt's Cloud Run deployment.
    cloud_env = Path("/secrets/.env")
    return Settings(_env_file=cloud_env if cloud_env.is_file() else ".env")
