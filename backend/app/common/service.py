from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class BaseService:
    """Request-scoped database, actor, transactions and membership checks."""

    def __init__(self, db: Any, user: dict[str, Any]):
        self.db = db
        self.user = user
        self.user_id = str(user["id"])

    def _transaction(self, callback):
        with self.db.client.start_session() as session:
            return session.with_transaction(lambda active: callback(active))

    def _member(self, session=None, *, admin=False) -> dict[str, Any]:
        member = self.db.members.find_one({"user_id": self.user_id}, session=session)
        if not member or member.get("is_disabled"):
            raise HTTPException(403, "active_membership_required")
        if admin and not member.get("is_admin"):
            raise HTTPException(403, "admin_required")
        return member
