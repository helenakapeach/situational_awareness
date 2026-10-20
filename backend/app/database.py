"""Mongo indexes and startup initialization; no business actions."""

from typing import Any

from pymongo import ASCENDING, DESCENDING


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
