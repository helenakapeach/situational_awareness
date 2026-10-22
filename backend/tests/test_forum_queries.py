"""Feed reads stay batched without truncating threads or changing serialization."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from pymongo import MongoClient
from pymongo.monitoring import CommandListener

from app.forum.service import ForumService


class ReadCommands(CommandListener):
    def __init__(self):
        self.commands = []

    def started(self, event):
        if event.command_name in {"find", "aggregate", "getMore"}:
            self.commands.append(event.command_name)

    def succeeded(self, event):
        pass

    def failed(self, event):
        pass


@pytest.mark.parametrize("post_count,reply_count", [(1, 0), (1, 105), (20, 105)])
def test_thread_reads_are_batched_and_preserve_behavior(db, post_count, reply_count):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.members.insert_one({"user_id": "viewer"})
    db.profiles.insert_one(
        {
            "user_id": "viewer",
            "public_id": "public-viewer",
            "display_name": "Current name",
            "cohort_id": 1,
            "role": "student",
        }
    )
    db.cohorts.update_one({"id": 1}, {"$set": {"name": "Current cohort"}})
    db.posts.insert_many(
        [
            {
                "id": n,
                "title": "needle",
                "body": "body",
                "created_at": now,
                "author_id": "viewer",
                "is_anonymous": False,
                "author_name": "Stale name",
            }
            for n in range(1, post_count + 1)
        ]
    )
    # Replies span anonymous/named OP, a missing profile and a missing cohort.
    db.profiles.insert_one(
        {"user_id": "other", "public_id": "public-other", "display_name": "Other", "cohort_id": 999}
    )
    if reply_count:
        db.replies.insert_many(
            [
                {
                    "id": n,
                    "post_id": post_count,
                    "parent_reply_id": 1 if n > 1 else None,
                    "body": f"reply {n}",
                    "created_at": now + timedelta(seconds=n // 2),
                    "author_id": ["viewer", "viewer", "missing", "other"][n % 4],
                    "is_anonymous": n % 4 == 1,
                }
                for n in reversed(range(1, reply_count + 1))
            ]
        )
        db.reply_votes.insert_many(
            [{"reply_id": 2, "user_id": "viewer"}, {"reply_id": 2, "user_id": "other"}]
        )
    db.post_votes.insert_one({"post_id": post_count, "user_id": "other"})
    commands = ReadCommands()
    with MongoClient(os.environ["TEST_MONGODB_URI"], tz_aware=True, event_listeners=[commands]) as client:
        service = ForumService(client[db.name], {"id": "viewer"})
        posts = service.list_posts()
        # Member, posts, replies, profiles, cohorts and up to two vote aggregations.
        # Large results may need getMore batches; those only transfer the remaining rows.
        queries = [command for command in commands.commands if command != "getMore"]
        assert len(queries) == (7 if reply_count else 6)
        assert [post["id"] for post in posts] == list(range(post_count, 0, -1))
        post = posts[0]
        assert post["author_name"] == "Current name"
        assert post["author_cohort_name"] == "Current cohort"
        assert post["is_mine"] is True
        assert post["upvote_count"] == 1 and post["liked_by_me"] is False
        assert len(post["replies"]) == reply_count
        assert all(not item["replies"] for item in posts[1:])
        if reply_count:
            replies = post["replies"]
            assert [reply["id"] for reply in replies] == [2, 1, *range(3, reply_count + 1)]
            by_id = {reply["id"]: reply for reply in replies}
            assert by_id[2]["upvote_count"] == 2 and by_id[2]["liked_by_me"] is True
            assert by_id[1]["author_name"] == "匿名成员" and by_id[1]["is_op"] is False
            assert by_id[4]["is_op"] is True and by_id[4]["is_mine"] is True
            assert by_id[2]["author_name"] == "匿名成员"  # Missing profile fallback.
            assert by_id[3]["author_name"] == "Other" and by_id[3]["author_cohort_name"] is None
            assert by_id[4]["parent_reply_id"] == 1
            assert all("author_id" not in reply for reply in replies)
        assert service.search_posts("needle") == posts
        assert service.get_post(post_count) == post
        assert service.get_post(999) is None
        commands.commands.clear()
        assert service.search_posts("absent") == []
        assert len(commands.commands) == 2  # No hydration reads for an empty result.
