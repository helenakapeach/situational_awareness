from typing import Any

from fastapi import HTTPException
from pymongo import DESCENDING
from pymongo.errors import DuplicateKeyError

from ..common.service import BaseService, utc_now
from ..profile.service import ProfileService


class MembershipService(BaseService):
    """Membership and invitations; profile creation stays in the profile component."""

    def __init__(self, db: Any, user: dict[str, Any]):
        super().__init__(db, user)
        self.profiles = ProfileService(db, user)

    def member_access(self) -> dict[str, bool]:
        m = self.db.members.find_one({"user_id": self.user_id})
        return {
            "is_member": bool(m and not m.get("is_disabled")),
            "is_admin": bool(m and m.get("is_admin") and not m.get("is_disabled")),
            "is_disabled": bool(m and m.get("is_disabled")),
        }

    def is_member(self, user_id: str) -> bool:
        return (
            str(user_id) == self.user_id
            and self.db.members.find_one({"user_id": self.user_id}, {"_id": 1}) is not None
        )

    def redeem_invite_code(self, code: str) -> bool:
        normalized = (code or "").strip().upper()

        def redeem(session):
            existing = self.db.members.find_one({"user_id": self.user_id}, session=session)
            if existing:
                return not existing.get("is_disabled", False)
            if not normalized:
                return False
            invite = self.db.invite_codes.find_one({"code": normalized}, session=session)
            if not invite or not invite.get("is_active", True):
                return False
            quota = invite.get("max_uses")
            if quota is not None and invite.get("used_count", 0) >= quota:
                return False
            self.db.members.insert_one(
                {
                    "user_id": self.user_id,
                    "invite_code": normalized,
                    "email": self.user.get("email"),
                    "joined_at": utc_now(),
                    "is_admin": False,
                    "is_disabled": False,
                },
                session=session,
            )
            self.db.invite_codes.update_one(
                {"_id": invite["_id"]}, {"$inc": {"used_count": 1}}, session=session
            )
            self.profiles.ensure_profile(session)
            return True

        try:
            return self._transaction(redeem)
        except DuplicateKeyError:
            # Another request for this user may have committed on a different
            # invite code while this transaction was in flight.
            existing = self.db.members.find_one({"user_id": self.user_id})
            if existing:
                return not existing.get("is_disabled", False)
            raise

    def admin_members(self) -> list[dict[str, Any]]:
        self._member(admin=True)
        rows = []
        for member in self.db.members.find().sort("joined_at", DESCENDING):
            user_id = member["user_id"]
            profile = self.profiles.get_internal_profile(user_id)
            cohort = self.db.cohorts.find_one({"id": (profile or {}).get("cohort_id")}) if profile else None
            rows.append(
                {
                    "user_id": user_id,
                    "name": (profile or {}).get("display_name"),
                    "email": member.get("email") or "",
                    "joined_at": member.get("joined_at"),
                    "is_disabled": bool(member.get("is_disabled")),
                    "is_admin": bool(member.get("is_admin")),
                    "display_name": (profile or {}).get("display_name"),
                    "role": (profile or {}).get("role"),
                    "cohort_name": (profile or {}).get("cohort_name") or (cohort or {}).get("name"),
                    "role_verified": bool((profile or {}).get("role_verified")),
                }
            )
        return rows

    def admin_set_disabled(self, user_id: str, disabled: bool) -> None:
        self._member(admin=True)
        result = self.db.members.update_one(
            {"user_id": str(user_id), "is_admin": {"$ne": True}}, {"$set": {"is_disabled": bool(disabled)}}
        )
        if not result.matched_count:
            raise HTTPException(400, "用户不存在，或该账号是管理员。")
