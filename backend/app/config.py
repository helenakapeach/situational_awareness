from functools import lru_cache
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_server: str = "mongodb://localhost:27017"
    mongodb_username: str = ""
    mongodb_password: SecretStr = SecretStr("")
    mongodb_app_name: str = "linghang-main-app"
    mongodb_options: dict[str, str | bool | int] = Field(default_factory=dict)
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

    @field_validator("mongodb_server")
    @classmethod
    def mongo_server_only(cls, value: str) -> str:
        server = urlsplit(value)
        if (
            server.scheme not in {"mongodb", "mongodb+srv"}
            or not server.netloc
            or server.username is not None
            or server.password is not None
            or server.path not in {"", "/"}
            or server.query
            or server.fragment
        ):
            raise ValueError("MONGODB_SERVER must contain only mongodb[+srv]://host[:port]")
        return value.rstrip("/")

    @field_validator("mongodb_options")
    @classmethod
    def mongo_options_only(cls, value: dict) -> dict:
        if any(key.lower() in {"appname", "username", "password"} for key in value):
            raise ValueError("Use the dedicated Mongo username, password and app-name fields")
        return value

    @model_validator(mode="after")
    def paired_mongo_credentials(self):
        if bool(self.mongodb_username) != bool(self.mongodb_password.get_secret_value()):
            raise ValueError("MONGODB_USERNAME and MONGODB_PASSWORD must be configured together")
        return self

    @property
    def mongodb_uri(self) -> str:
        scheme, server = self.mongodb_server.split("://", 1)
        credentials = ""
        if self.mongodb_username:
            username = quote(self.mongodb_username, safe="")
            password = quote(self.mongodb_password.get_secret_value(), safe="")
            credentials = f"{username}:{password}@"
        options = {**self.mongodb_options, "appName": self.mongodb_app_name}
        query = urlencode(
            {key: str(value).lower() if isinstance(value, bool) else value for key, value in options.items()}
        )
        return f"{scheme}://{credentials}{server}/?{query}"

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
