"""Request models for profile operations."""

import re
from typing import Literal

from pydantic import Field, model_validator

from ..common.models import Payload

Role = Literal["committee", "mentor", "student", "other"]


class VerificationUpdate(Payload):
    verified: bool


class ProfileUpdate(Payload):
    display_name: str = Field(min_length=1, max_length=30)
    tagline: str | None = Field(default=None, max_length=60)
    bio: str | None = Field(default=None, max_length=500)
    linkedin_url: str | None = Field(default=None, max_length=256)
    linkedin_public: bool = False
    contact_email: str | None = Field(default=None, max_length=120)
    email_public: bool = False
    wechat_id: str | None = Field(default=None, max_length=20)
    wechat_public: bool = False
    role: Role | None = None
    cohort_id: int | None = Field(default=None, gt=0)
    graduation_year: int | None = Field(default=None, ge=2016, le=2027)

    @model_validator(mode="after")
    def normalize_profile(self):
        for name in ("tagline", "bio", "linkedin_url", "contact_email", "wechat_id"):
            setattr(self, name, getattr(self, name) or None)
        for name in ("display_name", "tagline"):
            if any(ord(c) < 32 or ord(c) == 127 for c in getattr(self, name) or ""):
                raise ValueError(f"{name} cannot contain control characters")
        if self.linkedin_url:
            url = self.linkedin_url
            if not url.startswith("https://"):
                url = "https://" + url.removeprefix("http://")
            if not re.fullmatch(r"https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%-]{3,100}/?", url):
                raise ValueError("Invalid LinkedIn profile URL")
            self.linkedin_url = url
        if self.contact_email:
            self.contact_email = self.contact_email.lower()
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", self.contact_email):
                raise ValueError("Invalid contact email")
        if self.wechat_id and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{5,19}", self.wechat_id):
            raise ValueError("Invalid WeChat ID")
        self.linkedin_public = self.linkedin_public and bool(self.linkedin_url)
        self.email_public = self.email_public and bool(self.contact_email)
        self.wechat_public = self.wechat_public and bool(self.wechat_id)
        if self.role != "student":
            self.cohort_id = None
            self.graduation_year = None
        return self
