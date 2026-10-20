"""Service integration tests against the replica-set MongoDB ``db`` fixture."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.database import bootstrap_indexes
from app.forum.service import ForumService
from app.membership.service import MembershipService
from app.profile.service import ProfileService


def add_member(db, user_id, *, admin=False, disabled=False, name=None, email=None, avatar=None):
    db.members.insert_one(
        {
            "user_id": user_id,
            "is_admin": admin,
            "is_disabled": disabled,
            "joined_at": datetime.now(timezone.utc),
            "email": email,
        }
    )
    profile = {
        "user_id": user_id,
        "public_id": f"public-{user_id}",
        "display_name": name or user_id,
        "avatar_url": avatar,
        "role_verified": False,
    }
    db.profiles.insert_one(profile)
    return profile


def actor(db, user_id, service_type, **metadata):
    return service_type(db, {"id": user_id, "email": f"{user_id}@example.com", "user_metadata": metadata})


def forum_service(db, user_id, **metadata):
    return actor(db, user_id, ForumService, **metadata)


def profile_service(db, user_id, **metadata):
    return actor(db, user_id, ProfileService, **metadata)


def membership_service(db, user_id, **metadata):
    return actor(db, user_id, MembershipService, **metadata)


@pytest.fixture(autouse=True)
def mongo_indexes(db):
    bootstrap_indexes(db)


def test_invite_quota_and_idempotent_redemption(db):
    db.invite_codes.insert_one({"code": "ONEUSE", "is_active": True, "max_uses": 1, "used_count": 0})
    assert membership_service(db, "invited-a").redeem_invite_code(" oneuse ") is True
    assert membership_service(db, "invited-a").redeem_invite_code("wrong") is True
    assert membership_service(db, "invited-b").redeem_invite_code("ONEUSE") is False
    assert db.invite_codes.find_one({"code": "ONEUSE"})["used_count"] == 1
    assert db.profiles.find_one({"user_id": "invited-a"}) is not None


def test_invite_quota_is_serialized_across_concurrent_redemptions(db):
    db.invite_codes.insert_one({"code": "RACE", "is_active": True, "max_uses": 2, "used_count": 0})
    users = [f"racer-{n}" for n in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda uid: membership_service(db, uid).redeem_invite_code("RACE"), users))
    assert sum(results) == 2
    assert db.invite_codes.find_one({"code": "RACE"})["used_count"] == 2
    assert db.members.count_documents({"invite_code": "RACE"}) == 2


def test_content_ownership_anonymity_and_op_state(db):
    add_member(db, "writer")
    add_member(db, "reader")
    writer = forum_service(db, "writer")
    reader = forum_service(db, "reader")
    writer.create_post({"title": "Question", "body": "Body", "is_anonymous": True})
    post = db.posts.find_one({"author_id": "writer"})
    writer.create_reply(post["id"], {"body": "Same anonymous author", "is_anonymous": True})
    writer.create_reply(post["id"], {"body": "Named author", "is_anonymous": False})
    listed = reader.list_posts()[0]
    fetched = reader.get_post(post["id"])
    assert listed["author_name"] == "匿名成员"
    assert "author_id" not in listed and "author_id" not in listed["replies"][0]
    assert [r["is_op"] for r in listed["replies"]] == [True, False]
    assert [r["is_op"] for r in fetched["replies"]] == [True, False]
    with pytest.raises(HTTPException):
        reader.update_post(post["id"], {"title": "Hijacked"})
    writer.update_post(post["id"], {"title": "Updated", "is_anonymous": False})
    assert db.posts.find_one({"id": post["id"]})["is_anonymous"] is True


def test_reply_delete_promotes_children_and_post_delete_cascades_votes(db):
    add_member(db, "author")
    add_member(db, "other")
    author = forum_service(db, "author")
    other = forum_service(db, "other")
    author.create_post({"title": "Question", "body": "Body", "is_anonymous": False})
    post_id = db.posts.find_one({"author_id": "author"})["id"]
    author.create_reply(post_id, {"body": "Parent", "is_anonymous": False})
    parent_id = db.replies.find_one({"post_id": post_id})["id"]
    other.create_reply(post_id, {"body": "Child", "is_anonymous": True, "parent_reply_id": parent_id})
    child_id = db.replies.find_one({"body": "Child"})["id"]
    other.toggle_reply_vote(child_id)
    author.delete_reply(parent_id)
    assert db.replies.find_one({"id": child_id})["parent_reply_id"] is None
    assert db.reply_votes.count_documents({"reply_id": child_id}) == 1
    other.toggle_post_vote(post_id)
    author.delete_post(post_id)
    assert db.posts.count_documents({"id": post_id}) == 0
    assert db.replies.count_documents({"post_id": post_id}) == 0
    assert db.post_votes.count_documents({"post_id": post_id}) == 0
    assert db.reply_votes.count_documents({"reply_id": child_id}) == 0


def test_profile_privacy_verification_and_disabled_target(db):
    add_member(db, "admin", admin=True)
    add_member(db, "student", name="Student")
    admin = profile_service(db, "admin")
    student = profile_service(db, "student")
    student.update_own_profile(
        {
            "display_name": "Student",
            "role": "student",
            "cohort_id": 1,
            "contact_email": "private@example.com",
            "email_public": False,
        }
    )
    admin.admin_set_role_verified("student", True)
    assert student.get_own_profile()["role_verified"] is True
    updated = student.update_own_profile(
        {
            "display_name": "Student",
            "role": "student",
            "cohort_id": 1,
            "role_verified": True,
            "avatar_url": "https://bad.example/a",
        }
    )
    assert updated["role_verified"] is True
    assert updated["avatar_url"] == ""
    card = admin.get_profile("public-student")
    assert card["is_self"] is False
    assert "contact_email" not in card
    membership_service(db, "admin").admin_set_disabled("student", True)
    with pytest.raises(HTTPException) as error:
        admin.get_profile("public-student")
    assert error.value.status_code == 404


def test_profile_change_clears_verification_and_retired_cohort_can_remain(db):
    add_member(db, "admin", admin=True)
    add_member(db, "student")
    student = profile_service(db, "student")
    student.update_own_profile({"display_name": "Student", "role": "student", "cohort_id": 1})
    profile_service(db, "admin").admin_set_role_verified("student", True)
    db.cohorts.update_one({"id": 1}, {"$set": {"is_active": False}})
    unchanged = student.update_own_profile({"display_name": "Student", "role": "student", "cohort_id": 1})
    assert unchanged["cohort_name"] == "创业"
    assert unchanged["role_verified"] is True
    changed = student.update_own_profile({"display_name": "Student", "role": "student", "cohort_id": None})
    assert changed["cohort_name"] is None
    assert changed["role_verified"] is False


def test_avatar_replacement_and_clear_restore_google_avatar(db):
    google = "https://images.example/avatar"
    add_member(db, "avatar-user", avatar=google)
    actor = profile_service(db, "avatar-user", avatar_url=google)
    first = actor.upload_avatar(b"first")
    first_id = first["avatar_url"]
    assert first["is_self"] is True
    assert actor.get_avatar(first_id)["data"] == b"first"
    second = actor.upload_avatar(b"second")
    second_id = second["avatar_url"]
    assert actor.get_avatar(first_id) is None
    assert actor.get_avatar(second_id)["data"] == b"second"
    cleared = actor.clear_avatar()
    assert cleared["avatar_url"] == google
    assert actor.get_avatar(second_id) is None


def test_liked_lists_choose_newest_content_before_limiting(db):
    add_member(db, "liker")
    liker = forum_service(db, "liker")
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    for n in range(105):
        post_id = n + 1
        db.posts.insert_one(
            {
                "id": post_id,
                "title": f"P{n}",
                "body": "",
                "author_id": "writer",
                "is_anonymous": True,
                "created_at": start.replace(day=1),
            }
        )
        db.post_votes.insert_one({"post_id": post_id, "user_id": "liker", "created_at": start})
    newest = 999
    db.posts.insert_one(
        {
            "id": newest,
            "title": "Newest",
            "body": "",
            "author_id": "writer",
            "is_anonymous": True,
            "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        }
    )
    db.post_votes.insert_one({"post_id": newest, "user_id": "liker", "created_at": start})
    liked = liker.list_liked()["posts"]
    assert len(liked) == 100
    assert liked[0]["id"] == newest


def test_named_content_identity_updates_dynamically(db):
    add_member(db, "author", name="Before")
    author = forum_service(db, "author")
    author.create_post({"title": "Question", "body": "Body", "is_anonymous": False})
    post_id = db.posts.find_one({"author_id": "author"})["id"]
    author.create_reply(post_id, {"body": "Reply", "is_anonymous": False})
    profile_service(db, "author").update_own_profile({"display_name": "After", "role": "mentor"})
    feed_item = author.list_posts()[0]
    assert feed_item["author_name"] == "After"
    assert feed_item["author_role"] == "mentor"
    assert feed_item["replies"][0]["author_name"] == "After"


def test_votes_toggle_counts_and_liked_by_me(db):
    add_member(db, "author")
    add_member(db, "voter")
    author = forum_service(db, "author")
    voter = forum_service(db, "voter")
    author.create_post({"title": "Question", "body": "Body", "is_anonymous": True})
    post_id = db.posts.find_one({"author_id": "author"})["id"]
    author.create_reply(post_id, {"body": "Reply", "is_anonymous": False})
    reply_id = db.replies.find_one({"post_id": post_id})["id"]
    voter.toggle_post_vote(post_id)
    voter.toggle_reply_vote(reply_id)
    item = voter.get_post(post_id)
    assert item["upvote_count"] == 1 and item["liked_by_me"] is True
    assert item["replies"][0]["upvote_count"] == 1
    assert item["replies"][0]["liked_by_me"] is True
    voter.toggle_post_vote(post_id)
    voter.toggle_reply_vote(reply_id)
    item = voter.get_post(post_id)
    assert item["upvote_count"] == 0 and item["liked_by_me"] is False
    assert item["replies"][0]["upvote_count"] == 0


def test_role_verification_requires_selected_role(db):
    add_member(db, "admin", admin=True)
    add_member(db, "member")
    admin = profile_service(db, "admin")
    with pytest.raises(HTTPException) as error:
        admin.admin_set_role_verified("member", True)
    assert error.value.status_code == 400
    assert membership_service(db, "admin").admin_members()[1]["role_verified"] is False


def test_concurrent_duplicate_redemption_for_same_user_charges_once(db):
    db.invite_codes.insert_many(
        [
            {"code": "FIRST", "is_active": True, "max_uses": 1, "used_count": 0},
            {"code": "SECOND", "is_active": True, "max_uses": 1, "used_count": 0},
        ]
    )
    codes = ["FIRST", "SECOND"] * 4
    with ThreadPoolExecutor(max_workers=len(codes)) as pool:
        results = list(
            pool.map(lambda code: membership_service(db, "same-user").redeem_invite_code(code), codes)
        )
    assert all(results)
    assert db.members.count_documents({"user_id": "same-user"}) == 1
    assert sum(db.invite_codes.find_one({"code": code})["used_count"] for code in ("FIRST", "SECOND")) == 1


def test_disabled_member_cannot_write_content(db):
    add_member(db, "disabled", disabled=True)
    with pytest.raises(HTTPException) as error:
        forum_service(db, "disabled").create_post({"title": "Question", "body": "Body", "is_anonymous": True})
    assert error.value.status_code == 403


def test_pagination_ties_use_numeric_id_cursor(db):
    add_member(db, "reader")
    timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.posts.insert_many(
        [
            {
                "id": n,
                "title": "Title",
                "body": "Body",
                "author_id": "reader",
                "created_at": timestamp,
                "is_anonymous": True,
            }
            for n in range(1, 26)
        ]
    )
    reader = forum_service(db, "reader")
    first = reader.list_posts()
    second = reader.list_posts(before=first[-1]["created_at"], before_id=first[-1]["id"])
    assert [p["id"] for p in first + second] == list(range(25, 0, -1))


def test_cohort_rename_and_nonstudent_change_reflect_in_named_content(db):
    add_member(db, "student")
    student = forum_service(db, "student")
    profile_service(db, "student").update_own_profile(
        {"display_name": "Student", "role": "student", "cohort_id": 1}
    )
    student.create_post({"title": "Question", "body": "Body", "is_anonymous": False})
    db.cohorts.update_one({"id": 1}, {"$set": {"name": "Renamed cohort"}})
    assert student.list_posts()[0]["author_cohort_name"] == "Renamed cohort"
    assert profile_service(db, "student").get_profile("public-student")["cohort_name"] == "Renamed cohort"
    bootstrap_indexes(db)  # Restart must preserve operator-maintained cohort names.
    assert db.cohorts.find_one({"id": 1})["name"] == "Renamed cohort"
    updated = profile_service(db, "student").update_own_profile({"display_name": "Mentor", "role": "mentor"})
    assert updated["cohort_id"] is None and updated["cohort_name"] is None
    assert student.list_posts()[0]["author_cohort_name"] is None


def test_parallel_vote_toggles_serialize_without_duplicate_votes(db):
    add_member(db, "writer")
    writer = forum_service(db, "writer")
    writer.create_post({"title": "Question", "body": "Body"})
    post_id = db.posts.find_one({})["id"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: forum_service(db, "writer").toggle_post_vote(post_id), range(8)))
    assert db.post_votes.count_documents({"post_id": post_id}) == 0
