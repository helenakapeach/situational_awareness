"""Profile and avatar business rules."""

from __future__ import annotations

from typing import Any, get_args
from uuid import uuid4

from fastapi import HTTPException
from pymongo import ASCENDING

from ..common.service import BaseService, utc_now
from .models import ProfileUpdate, Role

PROFILE_FIELDS = tuple(ProfileUpdate.model_fields)
ROLES = frozenset(get_args(Role))


class ProfileService(BaseService):
    def get_internal_profile(self, user_id: str, session=None) -> dict[str, Any] | None:
        profile = self.db.profiles.find_one({"user_id": str(user_id)}, session=session)
        if profile:
            cohort_id = profile.get("cohort_id")
            cohort = (
                self.db.cohorts.find_one({"id": cohort_id}, {"name": 1}, session=session)
                if cohort_id is not None
                else None
            )
            profile["cohort_name"] = cohort["name"] if cohort else None
        return profile

    @staticmethod
    def author_identity(profile: dict[str, Any] | None) -> dict[str, Any]:
        if not profile:
            return dict(
                author_name="匿名成员",
                author_avatar_url="",
                author_public_id=None,
                author_role=None,
                author_cohort_name=None,
                author_role_verified=False,
            )
        return dict(
            author_name=profile.get("display_name", "成员"),
            author_avatar_url=profile.get("avatar_url") or "",
            author_public_id=profile.get("public_id"),
            author_role=profile.get("role"),
            author_cohort_name=profile.get("cohort_name"),
            author_role_verified=bool(profile.get("role_verified")),
        )

    def ensure_profile(self, session=None) -> dict[str, Any]:
        profile = self.get_internal_profile(self.user_id, session)
        if profile:
            return profile
        meta = self.user.get("user_metadata") or {}
        raw_name = meta.get("full_name") or meta.get("name") or "Google 用户"
        clean_name = (
            "".join(c for c in str(raw_name).strip()[:30] if ord(c) >= 32 and ord(c) != 127).strip()
            or "Google 用户"
        )
        profile = {
            "user_id": self.user_id,
            "public_id": str(uuid4()),
            "display_name": clean_name,
            "avatar_url": self._google_avatar(),
            "role_verified": False,
            "updated_at": utc_now(),
        }
        self.db.profiles.update_one(
            {"user_id": self.user_id}, {"$setOnInsert": profile}, upsert=True, session=session
        )
        return self.get_internal_profile(self.user_id, session) or profile

    def _google_avatar(self) -> str | None:
        avatar = str((self.user.get("user_metadata") or {}).get("avatar_url") or "").strip()
        return avatar if avatar.startswith("https://") and len(avatar) <= 2048 else None

    def _profile_response(self, profile: dict[str, Any], *, self_profile: bool) -> dict[str, Any]:
        result = {k: profile.get(k) for k in ["public_id", *PROFILE_FIELDS, "cohort_name"]}
        if result["cohort_name"] is None and profile.get("cohort_id") is not None:
            cohort = self.db.cohorts.find_one({"id": profile["cohort_id"]}, {"name": 1})
            if cohort:
                result["cohort_name"] = cohort["name"]
        result["role_verified"] = bool(profile.get("role_verified"))
        for key in ("linkedin_public", "email_public", "wechat_public"):
            result[key] = bool(profile.get(key))
        result["avatar_url"] = profile.get("avatar_url") or ""
        result["is_self"] = self_profile
        return result

    def get_own_profile(self) -> dict[str, Any]:
        self._member()
        return self._profile_response(self.ensure_profile(), self_profile=True)

    def get_profile(self, public_id: str) -> dict[str, Any]:
        self._member()
        profile = self.db.profiles.find_one({"public_id": public_id})
        if not profile:
            raise HTTPException(404, "profile_not_found")
        profile = self.get_internal_profile(profile["user_id"])
        target_member = self.db.members.find_one({"user_id": profile["user_id"]})
        if not target_member or target_member.get("is_disabled"):
            raise HTTPException(404, "profile_not_found")
        card = {
            "public_id": profile["public_id"],
            "display_name": profile.get("display_name"),
            "tagline": profile.get("tagline"),
            "bio": profile.get("bio"),
            "avatar_url": profile.get("avatar_url") or "",
            "role": profile.get("role"),
            "cohort_name": profile.get("cohort_name"),
            "graduation_year": profile.get("graduation_year"),
            "role_verified": bool(profile.get("role_verified")),
            "is_self": profile.get("user_id") == self.user_id,
        }
        for flag, field in (
            ("linkedin_public", "linkedin_url"),
            ("email_public", "contact_email"),
            ("wechat_public", "wechat_id"),
        ):
            if profile.get(flag) and profile.get(field):
                card[field] = profile[field]
        return card

    def list_cohorts(self) -> list[dict[str, Any]]:
        self._member()
        return [
            {"id": cohort["id"], "name": cohort["name"]}
            for cohort in self.db.cohorts.find({"is_active": True}, {"_id": 0, "id": 1, "name": 1}).sort(
                "sort_order", ASCENDING
            )
        ]

    def update_own_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        self._member()
        updates = {key: profile[key] for key in PROFILE_FIELDS if key in profile}

        def update(session):
            old = self.ensure_profile(session)
            next_role = updates.get("role", old.get("role"))
            next_cohort = updates.get("cohort_id", old.get("cohort_id"))
            if next_role not in (None, *ROLES):
                raise HTTPException(400, "invalid_role")
            if next_role != "student":
                updates["cohort_id"] = None
                updates["graduation_year"] = None
                updates["cohort_name"] = None
                next_cohort = None
            elif next_cohort is None:
                updates["cohort_name"] = None
            elif next_cohort != old.get("cohort_id"):
                cohort = self.db.cohorts.find_one({"id": next_cohort, "is_active": True}, session=session)
                if not cohort:
                    raise HTTPException(400, "invalid_cohort")
                updates["cohort_name"] = cohort["name"]
            if next_role != old.get("role") or next_cohort != old.get("cohort_id"):
                updates["role_verified"] = False
            updates["updated_at"] = utc_now()
            self.db.profiles.update_one({"user_id": self.user_id}, {"$set": updates}, session=session)
            return self.get_internal_profile(self.user_id, session)

        result = self._transaction(update)
        return self._profile_response(result, self_profile=True)

    def upload_avatar(self, data: bytes) -> dict[str, Any]:
        self._member()
        avatar_id = f"{uuid4()}.webp"

        def save(session):
            profile = self.ensure_profile(session)
            old_avatar = profile.get("avatar_url")
            self.db.avatars.insert_one(
                {"id": avatar_id, "data": data, "content_type": "image/webp", "created_at": utc_now()},
                session=session,
            )
            self.db.profiles.update_one(
                {"user_id": self.user_id},
                {"$set": {"avatar_url": avatar_id, "updated_at": utc_now()}},
                session=session,
            )
            self._delete_custom_avatar(old_avatar, session)
            profile["avatar_url"] = avatar_id
            return self._profile_response(profile, self_profile=True)

        return self._transaction(save)

    @staticmethod
    def _is_custom_avatar(avatar_url: Any) -> bool:
        return isinstance(avatar_url, str) and avatar_url.endswith(".webp") and len(avatar_url) == 41

    def _delete_custom_avatar(self, avatar_url: Any, session) -> None:
        if self._is_custom_avatar(avatar_url):
            self.db.avatars.delete_one({"id": avatar_url}, session=session)

    def get_avatar(self, avatar_id: str) -> dict[str, Any] | None:
        return self.db.avatars.find_one({"id": avatar_id}, {"_id": 0})

    def clear_avatar(self) -> dict[str, Any]:
        self._member()

        def clear(session):
            profile = self.ensure_profile(session)
            old_avatar = profile.get("avatar_url")
            google_avatar = self._google_avatar()
            self.db.profiles.update_one(
                {"user_id": self.user_id},
                {"$set": {"avatar_url": google_avatar, "updated_at": utc_now()}},
                session=session,
            )
            self._delete_custom_avatar(old_avatar, session)
            profile["avatar_url"] = google_avatar
            return self._profile_response(profile, self_profile=True)

        return self._transaction(clear)

    def admin_set_role_verified(self, user_id: str, verified: bool) -> None:
        self._member(admin=True)
        query: dict[str, Any] = {"user_id": str(user_id)}
        if verified:
            query["role"] = {"$ne": None}
        result = self.db.profiles.update_one(
            query, {"$set": {"role_verified": bool(verified), "updated_at": utc_now()}}
        )
        if not result.matched_count:
            exists = self.db.profiles.find_one({"user_id": str(user_id)}, {"_id": 1})
            if not exists:
                raise HTTPException(404, "用户不存在。")
            raise HTTPException(400, "对方还没有选择角色。")
