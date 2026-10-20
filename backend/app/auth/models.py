from typing import Literal

from pydantic import Field, model_validator

from ..common.models import Payload


class SessionRequest(Payload):
    provider: Literal["supabase", "auth0"] = "supabase"
    access_token: str | None = Field(default=None, min_length=1, max_length=20000)
    idToken: str | None = Field(default=None, min_length=1, max_length=20000)
    nonce: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def token_for_provider(self):
        if self.provider == "supabase" and not self.access_token:
            raise ValueError("access_token is required for Supabase")
        if self.provider == "auth0" and not self.idToken:
            raise ValueError("idToken is required for Auth0")
        return self
