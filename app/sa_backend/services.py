"""Mongo-backed application services for the Situational Awareness API."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

PROFILE_FIELDS = (
    "display_name tagline bio linkedin_url linkedin_public "
    "contact_email email_public wechat_id wechat_public role cohort_id "
    "graduation_year"
).split()
ROLES = {"committee", "mentor", "student", "other"}
PAGE_SIZE = 20
SEARCH_LIMIT = 50
MY_CONTENT_LIMIT = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public_id() -> str:
    return str(uuid4())


def create_indexes(db: Any) -> None:
    """Create indexes required by the service without changing collection data."""
    db.members.create_index("user_id", unique=True)
    db.users.create_index("id", unique=True)
    db.profiles.create_index("user_id", unique=True)
    db.profiles.create_index("public_id", unique=True)
    db.cohorts.create_index("name", unique=True)
    db.cohorts.create_index("id", unique=True)
    db.invite_codes.create_index("code", unique=True)
    db.posts.create_index("id", unique=True)
    db.posts.create_index([("created_at", DESCENDING), ("id", DESCENDING)])
    db.posts.create_index([("author_id", ASCENDING), ("created_at", DESCENDING)])
    db.replies.create_index("id", unique=True)
    db.replies.create_index([("post_id", ASCENDING), ("created_at", ASCENDING), ("id", ASCENDING)])
    db.replies.create_index([("author_id", ASCENDING), ("created_at", DESCENDING)])
    db.post_votes.create_index([("post_id", ASCENDING), ("user_id", ASCENDING)], unique=True)
    db.reply_votes.create_index([("reply_id", ASCENDING), ("user_id", ASCENDING)], unique=True)
    db.feedback.create_index("id", unique=True)
    db.avatars.create_index("id", unique=True)


def bootstrap_indexes(db: Any) -> None:
    """Create service indexes and seed the default cohorts/counters at startup."""
    marker = db.migration_state.find_one({"_id": "supabase-to-mongo"})
    if marker and marker.get("status") != "complete":
        raise RuntimeError(
            "Migration is incomplete; finish and verify the import before serving this database"
        )
    create_indexes(db)
    if marker:
        # Imported cohort IDs/names and counter highwaters are authoritative.
        return
    for cohort_id, name in enumerate(("创业", "职业组进阶班", "职业组成长版"), start=1):
        db.cohorts.update_one(
            {"id": cohort_id},
            {"$setOnInsert": {"id": cohort_id, "name": name, "sort_order": cohort_id, "is_active": True}},
            upsert=True,
        )
    for counter in ("post", "reply", "feedback"):
        db.counters.update_one({"_id": counter}, {"$setOnInsert": {"value": 0}}, upsert=True)


class BackendService:
    """Business rules for an authenticated user and a synchronous PyMongo database."""

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

    def _profile(self, user_id: str, session=None) -> dict[str, Any] | None:
        profile = self.db.profiles.find_one({"user_id": user_id}, session=session)
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
    def _identity(profile: dict[str, Any] | None) -> dict[str, Any]:
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

    def _serialize_content(self, doc: dict[str, Any], kind: str, *, votes=True) -> dict[str, Any]:
        fields = (
            "id",
            "title",
            "body",
            "post_id",
            "parent_reply_id",
            "is_anonymous",
            "created_at",
            "updated_at",
        )
        result = {key: doc[key] for key in fields if key in doc}
        profile = self._profile(str(doc.get("author_id")))
        if doc.get("is_anonymous"):
            result.update(self._identity(None))
        else:
            result.update(self._identity(profile))
        collection = self.db.post_votes if kind == "post" else self.db.reply_votes
        id_field = "post_id" if kind == "post" else "reply_id"
        result["upvote_count"] = collection.count_documents({id_field: doc["id"]})
        result["is_mine"] = str(doc.get("author_id")) == self.user_id
        result["liked_by_me"] = (
            bool(collection.find_one({id_field: doc["id"], "user_id": self.user_id})) if votes else False
        )
        return result

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
                    "joined_at": _now(),
                    "is_admin": False,
                    "is_disabled": False,
                },
                session=session,
            )
            self.db.invite_codes.update_one(
                {"_id": invite["_id"]}, {"$inc": {"used_count": 1}}, session=session
            )
            self._ensure_profile(session)
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

    def _ensure_profile(self, session=None) -> dict[str, Any]:
        profile = self._profile(self.user_id, session)
        if profile:
            return profile
        meta = self.user.get("user_metadata") or {}
        raw_name = meta.get("full_name") or meta.get("name") or "Google 用户"
        clean_name = (
            "".join(c for c in str(raw_name).strip()[:30] if ord(c) >= 32 and ord(c) != 127).strip()
            or "Google 用户"
        )
        avatar = self._google_avatar()
        profile = {
            "user_id": self.user_id,
            "public_id": _public_id(),
            "display_name": clean_name,
            "avatar_url": avatar,
            "role_verified": False,
            "updated_at": _now(),
        }
        self.db.profiles.update_one(
            {"user_id": self.user_id}, {"$setOnInsert": profile}, upsert=True, session=session
        )
        return self._profile(self.user_id, session) or profile

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
        p = self._ensure_profile()
        return self._profile_response(p, self_profile=True)

    def get_profile(self, public_id: str) -> dict[str, Any]:
        self._member()
        p = self.db.profiles.find_one({"public_id": public_id})
        if not p:
            raise HTTPException(404, "profile_not_found")
        p = self._profile(p["user_id"])
        target_member = self.db.members.find_one({"user_id": p["user_id"]})
        if not target_member or target_member.get("is_disabled"):
            raise HTTPException(404, "profile_not_found")
        card = {
            "public_id": p["public_id"],
            "display_name": p.get("display_name"),
            "tagline": p.get("tagline"),
            "bio": p.get("bio"),
            "avatar_url": p.get("avatar_url") or "",
            "role": p.get("role"),
            "cohort_name": p.get("cohort_name"),
            "graduation_year": p.get("graduation_year"),
            "role_verified": bool(p.get("role_verified")),
            "is_self": p.get("user_id") == self.user_id,
        }
        for flag, field in (
            ("linkedin_public", "linkedin_url"),
            ("email_public", "contact_email"),
            ("wechat_public", "wechat_id"),
        ):
            if p.get(flag) and p.get(field):
                card[field] = p[field]
        return card

    def list_cohorts(self) -> list[dict[str, Any]]:
        self._member()
        return [
            {"id": c["id"], "name": c["name"]}
            for c in self.db.cohorts.find({"is_active": True}, {"_id": 0, "id": 1, "name": 1}).sort(
                "sort_order", ASCENDING
            )
        ]

    def update_own_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        self._member()
        updates = {k: profile[k] for k in PROFILE_FIELDS if k in profile}

        def update(session):
            old = self._ensure_profile(session)
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
            updates["updated_at"] = _now()
            self.db.profiles.update_one({"user_id": self.user_id}, {"$set": updates}, session=session)
            return self._profile(self.user_id, session)

        p = self._transaction(update)
        return self._profile_response(p, self_profile=True)

    def upload_avatar(self, data: bytes) -> dict[str, Any]:
        self._member()
        avatar_id = f"{uuid4()}.webp"

        def save(session):
            profile = self._ensure_profile(session)
            old_avatar = profile.get("avatar_url")
            self.db.avatars.insert_one(
                {"id": avatar_id, "data": data, "content_type": "image/webp", "created_at": _now()},
                session=session,
            )
            self.db.profiles.update_one(
                {"user_id": self.user_id},
                {"$set": {"avatar_url": avatar_id, "updated_at": _now()}},
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
            profile = self._ensure_profile(session)
            old_avatar = profile.get("avatar_url")
            google_avatar = self._google_avatar()
            self.db.profiles.update_one(
                {"user_id": self.user_id},
                {"$set": {"avatar_url": google_avatar, "updated_at": _now()}},
                session=session,
            )
            self._delete_custom_avatar(old_avatar, session)
            profile["avatar_url"] = google_avatar
            return self._profile_response(profile, self_profile=True)

        return self._transaction(clear)

    def _next_id(self, name: str, session) -> int:
        row = self.db.counters.find_one_and_update(
            {"_id": name},
            {"$inc": {"value": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
            session=session,
        )
        return int(row["value"])

    def _fence(self, collection: str, content_id: int, session) -> dict[str, Any]:
        """Serialize child writes with parent deletion through a shared document write."""
        row = self.db[collection].find_one_and_update(
            {"id": int(content_id)},
            {"$inc": {"revision": 1}},
            return_document=ReturnDocument.AFTER,
            session=session,
        )
        if not row:
            raise HTTPException(404, "content_not_found")
        return row

    def list_posts(
        self, before: datetime | str | None = None, before_id: int | None = None
    ) -> list[dict[str, Any]]:
        self._member()
        query: dict[str, Any] = {}
        if before is not None:
            if isinstance(before, str):
                before = datetime.fromisoformat(before.replace("Z", "+00:00"))
            query["$or"] = [
                {"created_at": {"$lt": before}},
                {"created_at": before, "id": {"$lt": before_id or 0}},
            ]
        posts = list(
            self.db.posts.find(query, {"_id": 0})
            .sort([("created_at", DESCENDING), ("id", DESCENDING)])
            .limit(PAGE_SIZE)
        )
        return self._hydrate_posts(posts)

    def _hydrate_posts(self, posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep feed and search thread privacy, votes and ownership identical."""
        result = []
        for post in posts:
            doc = self._serialize_content(post, "post")
            replies = list(
                self.db.replies.find({"post_id": post["id"]}, {"_id": 0}).sort(
                    [("created_at", ASCENDING), ("id", ASCENDING)]
                )
            )
            doc["replies"] = []
            for reply in replies:
                serialized = self._serialize_content(reply, "reply")
                serialized["is_op"] = reply.get("author_id") == post.get("author_id") and bool(
                    reply.get("is_anonymous")
                ) == bool(post.get("is_anonymous"))
                doc["replies"].append(serialized)
            doc["replies"].sort(key=lambda reply: (-reply["upvote_count"], reply["created_at"], reply["id"]))
            result.append(doc)
        return result

    def search_posts(self, term: str | None) -> list[dict[str, Any]]:
        """Find visible posts containing a literal, case-insensitive substring."""
        self._member()
        query = (term or "").strip(" ")
        if not 1 <= len(query) <= 100:
            return []

        # Escaping keeps %, _, and regex punctuation literal, as in the SQL
        # strpos implementation. Mongo regex matching is Unicode-aware, so
        # CJK terms remain searchable without any special handling.
        pattern = re.compile(re.escape(query), re.IGNORECASE)
        posts = list(
            self.db.posts.find({"$or": [{"title": pattern}, {"body": pattern}]}, {"_id": 0})
            .sort("created_at", DESCENDING)
            .limit(SEARCH_LIMIT)
        )
        return self._hydrate_posts(posts)

    def list_mine(self) -> dict[str, list[dict[str, Any]]]:
        """Return the caller's recent posts and replies without author identity."""
        self._member()
        posts = list(
            self.db.posts.find(
                {"author_id": self.user_id},
                {"_id": 0, "id": 1, "title": 1, "created_at": 1, "is_anonymous": 1},
            )
            .sort("created_at", DESCENDING)
            .limit(MY_CONTENT_LIMIT)
        )
        replies = []
        for reply in (
            self.db.replies.find(
                {"author_id": self.user_id},
                {
                    "_id": 0,
                    "id": 1,
                    "post_id": 1,
                    "body": 1,
                    "created_at": 1,
                    "is_anonymous": 1,
                },
            )
            .sort("created_at", DESCENDING)
            .limit(MY_CONTENT_LIMIT)
        ):
            parent = self.db.posts.find_one({"id": reply["post_id"]}, {"title": 1})
            if parent:
                reply["post_title"] = parent["title"]
                replies.append(reply)
        return {"posts": posts, "replies": replies}

    def get_post(self, post_id: int) -> dict[str, Any] | None:
        self._member()
        p = self.db.posts.find_one({"id": int(post_id)}, {"_id": 0})
        if not p:
            return None
        result = self._serialize_content(p, "post")
        result["replies"] = [
            self._serialize_content(r, "reply")
            for r in self.db.replies.find({"post_id": int(post_id)}, {"_id": 0}).sort(
                [("created_at", ASCENDING), ("id", ASCENDING)]
            )
        ]
        for reply in result["replies"]:
            raw_reply = self.db.replies.find_one({"id": reply["id"]}, {"author_id": 1, "is_anonymous": 1})
            reply["is_op"] = bool(
                raw_reply
                and raw_reply.get("author_id") == p.get("author_id")
                and bool(raw_reply.get("is_anonymous")) == bool(p.get("is_anonymous"))
            )
        result["replies"].sort(key=lambda reply: (-reply["upvote_count"], reply["created_at"], reply["id"]))
        return result

    def list_liked(self) -> dict[str, list[dict[str, Any]]]:
        self._member()
        post_vote_ids = {
            v["post_id"] for v in self.db.post_votes.find({"user_id": self.user_id}, {"post_id": 1})
        }
        reply_vote_ids = {
            v["reply_id"] for v in self.db.reply_votes.find({"user_id": self.user_id}, {"reply_id": 1})
        }
        posts = list(
            self.db.posts.find(
                {"id": {"$in": list(post_vote_ids)}},
                {"_id": 0, "id": 1, "title": 1, "created_at": 1, "is_anonymous": 1, "author_id": 1},
            )
            .sort("created_at", DESCENDING)
            .limit(100)
        )
        replies = []
        for r in (
            self.db.replies.find(
                {"id": {"$in": list(reply_vote_ids)}},
                {
                    "_id": 0,
                    "id": 1,
                    "post_id": 1,
                    "body": 1,
                    "created_at": 1,
                    "is_anonymous": 1,
                    "author_id": 1,
                },
            )
            .sort("created_at", DESCENDING)
            .limit(100)
        ):
            post = self.db.posts.find_one({"id": r["post_id"]}, {"id": 1, "title": 1})
            if not post:
                continue
            r["author_name"] = (
                "匿名成员"
                if r.get("is_anonymous")
                else self._identity(self._profile(str(r.get("author_id"))))["author_name"]
            )
            r["post_title"] = post["title"]
            r.pop("author_id", None)
            replies.append(r)
        for post in posts:
            post["author_name"] = (
                "匿名成员"
                if post.get("is_anonymous")
                else self._identity(self._profile(str(post.get("author_id"))))["author_name"]
            )
            post.pop("author_id", None)
        return {"posts": posts, "replies": replies}

    def create_post(self, post: dict[str, Any]) -> None:
        self._member()

        def create(session):
            profile = self._ensure_profile(session)
            anonymous = post.get("is_anonymous", True)
            row = {
                "id": self._next_id("post", session),
                "author_id": self.user_id,
                "title": post["title"],
                "body": post["body"],
                "is_anonymous": anonymous,
                "created_at": _now(),
                "updated_at": None,
            }
            row.update(self._identity(None if anonymous else profile))
            self.db.posts.insert_one(row, session=session)

        self._transaction(create)

    def update_post(self, post_id: int, post: dict[str, Any]) -> None:
        self._member()
        updates = {k: post[k] for k in ("title", "body") if k in post}
        updates["updated_at"] = _now()
        result = self.db.posts.update_one({"id": int(post_id), "author_id": self.user_id}, {"$set": updates})
        if not result.matched_count:
            raise HTTPException(404, "这条讨论已经不存在，或不是你的。")

    def delete_post(self, post_id: int) -> None:
        self._member()

        def delete(session):
            if not self.db.posts.find_one({"id": int(post_id), "author_id": self.user_id}, session=session):
                raise HTTPException(404, "这条讨论已经不存在，或不是你的。")
            self._delete_post_records(int(post_id), session)

        self._transaction(delete)

    def _delete_post_records(self, post_id: int, session):
        self._fence("posts", post_id, session)
        replies = [r["id"] for r in self.db.replies.find({"post_id": post_id}, {"id": 1}, session=session)]
        self.db.reply_votes.delete_many({"reply_id": {"$in": replies}}, session=session)
        self.db.replies.delete_many({"post_id": post_id}, session=session)
        self.db.post_votes.delete_many({"post_id": post_id}, session=session)
        self.db.posts.delete_one({"id": post_id}, session=session)

    def create_reply(self, post_id: int, reply: dict[str, Any]) -> None:
        self._member()

        def create(session):
            self._fence("posts", int(post_id), session)
            parent_reply_id = reply.get("parent_reply_id")
            if parent_reply_id is not None and not self.db.replies.find_one(
                {"id": int(parent_reply_id), "post_id": int(post_id)}, session=session
            ):
                raise HTTPException(400, "invalid_parent_reply")
            profile = self._ensure_profile(session)
            anonymous = bool(reply.get("is_anonymous"))
            row = {
                "id": self._next_id("reply", session),
                "post_id": int(post_id),
                "parent_reply_id": parent_reply_id,
                "author_id": self.user_id,
                "body": reply["body"],
                "is_anonymous": anonymous,
                "created_at": _now(),
                "updated_at": None,
            }
            row.update(self._identity(None if anonymous else profile))
            self.db.replies.insert_one(row, session=session)

        self._transaction(create)

    def update_reply(self, reply_id: int, body: str) -> None:
        self._member()
        result = self.db.replies.update_one(
            {"id": int(reply_id), "author_id": self.user_id}, {"$set": {"body": body, "updated_at": _now()}}
        )
        if not result.matched_count:
            raise HTTPException(404, "这条回复已经不存在，或不是你的。")

    def delete_reply(self, reply_id: int) -> None:
        self._member()

        def delete(session):
            if not self.db.replies.find_one(
                {"id": int(reply_id), "author_id": self.user_id}, session=session
            ):
                raise HTTPException(404, "这条回复已经不存在，或不是你的。")
            self._delete_reply_records(int(reply_id), session)

        self._transaction(delete)

    def _delete_reply_records(self, reply_id: int, session):
        reply = self.db.replies.find_one({"id": reply_id}, {"post_id": 1}, session=session)
        if not reply:
            return
        self._fence("posts", reply["post_id"], session)
        self._fence("replies", reply_id, session)
        self.db.replies.update_many(
            {"parent_reply_id": reply_id}, {"$set": {"parent_reply_id": None}}, session=session
        )
        self.db.reply_votes.delete_many({"reply_id": reply_id}, session=session)
        self.db.replies.delete_one({"id": reply_id}, session=session)

    def create_feedback(self, feedback: dict[str, Any]) -> None:
        self._member()

        def create(session):
            row = dict(
                feedback, id=self._next_id("feedback", session), user_id=self.user_id, created_at=_now()
            )
            self.db.feedback.insert_one(row, session=session)

        self._transaction(create)

    def toggle_post_vote(self, post_id: int) -> None:
        self._toggle_vote("post_votes", "post_id", int(post_id), "posts")

    def toggle_reply_vote(self, reply_id: int) -> None:
        self._toggle_vote("reply_votes", "reply_id", int(reply_id), "replies")

    def _toggle_vote(self, votes: str, key: str, content_id: int, collection: str) -> None:
        self._member()

        def toggle(session):
            if collection == "posts":
                self._fence("posts", content_id, session)
            else:
                reply = self._fence("replies", content_id, session)
                self._fence("posts", reply["post_id"], session)
            selector = {key: content_id, "user_id": self.user_id}
            if self.db[votes].find_one(selector, session=session):
                self.db[votes].delete_one(selector, session=session)
            else:
                self.db[votes].insert_one(dict(selector, created_at=_now()), session=session)

        self._transaction(toggle)

    def admin_members(self) -> list[dict[str, Any]]:
        self._member(admin=True)
        rows = []
        for member in self.db.members.find().sort("joined_at", DESCENDING):
            user_id = member["user_id"]
            profile = self._profile(user_id)
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

    def admin_set_role_verified(self, user_id: str, verified: bool) -> None:
        self._member(admin=True)
        query: dict[str, Any] = {"user_id": str(user_id)}
        if verified:
            query["role"] = {"$ne": None}
        result = self.db.profiles.update_one(
            query, {"$set": {"role_verified": bool(verified), "updated_at": _now()}}
        )
        if not result.matched_count:
            exists = self.db.profiles.find_one({"user_id": str(user_id)}, {"_id": 1})
            if not exists:
                raise HTTPException(404, "用户不存在。")
            raise HTTPException(400, "对方还没有选择角色。")

    def admin_delete_content(self, content_id: int, kind: str) -> None:
        self._member(admin=True)
        if kind not in {"post", "reply"}:
            raise HTTPException(400, "invalid_content_kind")

        def delete(session):
            if kind == "post":
                if not self.db.posts.find_one({"id": int(content_id)}, session=session):
                    raise HTTPException(404, "内容已经不存在。")
                self._delete_post_records(int(content_id), session)
            else:
                if not self.db.replies.find_one({"id": int(content_id)}, session=session):
                    raise HTTPException(404, "内容已经不存在。")
                self._delete_reply_records(int(content_id), session)

        self._transaction(delete)
