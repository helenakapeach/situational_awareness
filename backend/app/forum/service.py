"""Forum and discussion business rules."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from pymongo import ASCENDING, DESCENDING, ReturnDocument

from ..common.service import BaseService, utc_now
from ..profile.service import ProfileService

PAGE_SIZE = 20
SEARCH_LIMIT = 50
MY_CONTENT_LIMIT = 100


class ForumService(BaseService):
    """Business rules for member discussion content."""

    def __init__(self, db: Any, user: dict[str, Any]):
        super().__init__(db, user)
        self.profiles = ProfileService(db, user)

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
        profile = self.profiles.get_internal_profile(str(doc.get("author_id")))
        if doc.get("is_anonymous"):
            result.update(self.profiles.author_identity(None))
        else:
            result.update(self.profiles.author_identity(profile))
        collection = self.db.post_votes if kind == "post" else self.db.reply_votes
        id_field = "post_id" if kind == "post" else "reply_id"
        result["upvote_count"] = collection.count_documents({id_field: doc["id"]})
        result["is_mine"] = str(doc.get("author_id")) == self.user_id
        result["liked_by_me"] = (
            bool(collection.find_one({id_field: doc["id"], "user_id": self.user_id})) if votes else False
        )
        return result

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
            if r.get("is_anonymous"):
                r["author_name"] = "匿名成员"
            else:
                profile = self.profiles.get_internal_profile(str(r.get("author_id")))
                r["author_name"] = self.profiles.author_identity(profile)["author_name"]
            r["post_title"] = post["title"]
            r.pop("author_id", None)
            replies.append(r)
        for post in posts:
            if post.get("is_anonymous"):
                post["author_name"] = "匿名成员"
            else:
                profile = self.profiles.get_internal_profile(str(post.get("author_id")))
                post["author_name"] = self.profiles.author_identity(profile)["author_name"]
            post.pop("author_id", None)
        return {"posts": posts, "replies": replies}

    def create_post(self, post: dict[str, Any]) -> None:
        self._member()

        def create(session):
            profile = self.profiles.ensure_profile(session)
            anonymous = post.get("is_anonymous", True)
            row = {
                "id": self._next_id("post", session),
                "author_id": self.user_id,
                "title": post["title"],
                "body": post["body"],
                "is_anonymous": anonymous,
                "created_at": utc_now(),
                "updated_at": None,
            }
            row.update(self.profiles.author_identity(None if anonymous else profile))
            self.db.posts.insert_one(row, session=session)

        self._transaction(create)

    def update_post(self, post_id: int, post: dict[str, Any]) -> None:
        self._member()
        updates = {k: post[k] for k in ("title", "body") if k in post}
        updates["updated_at"] = utc_now()
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
            profile = self.profiles.ensure_profile(session)
            anonymous = bool(reply.get("is_anonymous"))
            row = {
                "id": self._next_id("reply", session),
                "post_id": int(post_id),
                "parent_reply_id": parent_reply_id,
                "author_id": self.user_id,
                "body": reply["body"],
                "is_anonymous": anonymous,
                "created_at": utc_now(),
                "updated_at": None,
            }
            row.update(self.profiles.author_identity(None if anonymous else profile))
            self.db.replies.insert_one(row, session=session)

        self._transaction(create)

    def update_reply(self, reply_id: int, body: str) -> None:
        self._member()
        result = self.db.replies.update_one(
            {"id": int(reply_id), "author_id": self.user_id},
            {"$set": {"body": body, "updated_at": utc_now()}},
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
                feedback, id=self._next_id("feedback", session), user_id=self.user_id, created_at=utc_now()
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
                self.db[votes].insert_one(dict(selector, created_at=utc_now()), session=session)

        self._transaction(toggle)

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
