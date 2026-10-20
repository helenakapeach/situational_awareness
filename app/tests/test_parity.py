"""Contract-driven checks shared with the frontend's Supabase-compatible adapter."""

import json
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sa_backend.auth import create_app_session_token
from sa_backend.config import get_settings
from sa_backend.main import create_app

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((ROOT / "test/fixtures/backend-contract.json").read_text())


def auth_headers(db, user_id):
    user = {
        "id": user_id,
        "email": f"{user_id}@example.test",
        "user_metadata": {"full_name": user_id, "avatar_url": "https://images.example.test/default.webp"},
    }
    db.users.update_one({"id": user_id}, {"$set": user}, upsert=True)
    return {"Authorization": f"Bearer {create_app_session_token(user, get_settings())}"}


def join(client, db, user_id):
    db.invite_codes.update_one(
        {"code": "PARITY"},
        {"$setOnInsert": {"code": "PARITY", "is_active": True, "used_count": 0, "max_uses": None}},
        upsert=True,
    )
    response = client.post(
        "/api/invite-redemptions", headers=auth_headers(db, user_id), json={"code": "parity"}
    )
    assert response.status_code == 200, response.text
    assert response.json() is True
    return auth_headers(db, user_id)


def assert_response_shape(action, response):
    assert response.status_code < 400, f"{action['name']} {action['method']} {response.url}: {response.text}"
    kind = action["response"]
    if kind == "void":
        assert response.status_code in (200, 201, 204)
        assert not response.content or response.json() is None
        return
    value = response.json()
    if kind == "object":
        assert isinstance(value, dict)
    elif kind == "array":
        assert isinstance(value, list)
    elif kind == "object_or_null":
        assert value is None or isinstance(value, dict)
    elif kind == "boolean":
        assert isinstance(value, bool)
    elif kind == "post_page":
        assert isinstance(value, list)
        assert all(isinstance(post, dict) and isinstance(post.get("replies"), list) for post in value)
    elif kind in {"likes", "own_content"}:
        assert isinstance(value, dict) and set(value) == {"posts", "replies"}
        assert isinstance(value["posts"], list) and isinstance(value["replies"], list)
    else:
        pytest.fail(f"Unknown response contract: {kind}")


def test_manifest_covers_all_non_deprecated_actions():
    assert len(CONTRACT["actions"]) == 25
    assert len({action["name"] for action in CONTRACT["actions"]}) == 25
    assert "isMember" not in {action["name"] for action in CONTRACT["actions"]}


def test_every_backend_contract_action_succeeds_with_declared_shape(db):
    with TestClient(create_app(db)) as client:
        owner = join(client, db, "contract-owner")
        member = join(client, db, "contract-member")
        db.members.update_one({"user_id": "contract-owner"}, {"$set": {"is_admin": True}})

        # Prepare the chosen profile, discussion, reply, and votes used by later actions.
        updated = client.put(
            "/api/profile",
            headers=owner,
            json={
                "display_name": "Contract Owner",
                "role": "mentor",
                "linkedin_url": "https://www.linkedin.com/in/owner",
            },
        )
        assert updated.status_code == 200, updated.text
        member_profile = client.put(
            "/api/profile",
            headers=member,
            json={"display_name": "Contract Member", "role": "student", "cohort_id": 1},
        )
        assert member_profile.status_code == 200, member_profile.text
        member_public_id = member_profile.json()["public_id"]
        main_post_response = client.post(
            "/api/posts",
            headers=owner,
            json={"title": "Contract discussion", "body": "Parity body", "is_anonymous": False},
        )
        assert main_post_response.status_code == 201, main_post_response.text
        main_post_id = db.posts.find_one({"title": "Contract discussion"})["id"]
        reply_response = client.post(
            f"/api/posts/{main_post_id}/replies",
            headers=owner,
            json={"body": "Existing owner reply", "is_anonymous": False},
        )
        assert reply_response.status_code == 201, reply_response.text
        seed_reply_id = db.replies.find_one({"post_id": main_post_id, "body": "Existing owner reply"})["id"]
        client.post(f"/api/posts/{main_post_id}/vote", headers=member)
        client.post(f"/api/replies/{seed_reply_id}/vote", headers=member)
        moderation_post = client.post(
            "/api/posts",
            headers=member,
            json={"title": "Moderation target", "body": "Remove this", "is_anonymous": True},
        )
        assert moderation_post.status_code == 201, moderation_post.text
        moderation_post_id = db.posts.find_one({"title": "Moderation target"})["id"]

        image = BytesIO()
        Image.new("RGB", (256, 256), "white").save(image, format="WEBP")
        avatar_bytes = image.getvalue()
        context = {
            "client": client,
            "owner": owner,
            "member": member,
            "main_post_id": main_post_id,
            "seed_reply_id": seed_reply_id,
            "moderation_post_id": moderation_post_id,
            "member_public_id": member_public_id,
            "avatar_bytes": avatar_bytes,
            "before": "2099-01-01T00:00:00Z",
            "before_id": 999999,
            "query": "Contract",
            "created_post_id": None,
            "created_reply_id": None,
            "uploaded_avatar_id": None,
        }

        def request_for(action):
            values = {
                "user_id": "contract-member",
                "kind": "post",
                "content_id": context["moderation_post_id"],
                "public_id": context["member_public_id"],
                "post_id": context["main_post_id"],
                "reply_id": context["seed_reply_id"],
                "before": context["before"],
                "before_id": context["before_id"],
                "query": context["query"],
            }
            path = action["path"].format(**values)
            name = action["name"]
            method = action["method"]
            body = None
            headers = context["owner"]
            if name == "adminSetDisabled":
                body = {"is_disabled": True}
            elif name == "adminSetRoleVerified":
                values["user_id"] = "contract-member"
                path = action["path"].format(**values)
                body = {"verified": True}
            elif name == "updateOwnProfile":
                body = {
                    "display_name": "Contract Owner Updated",
                    "role": "mentor",
                    "linkedin_url": "https://www.linkedin.com/in/owner",
                    "linkedin_public": True,
                }
            elif name == "uploadAvatar":
                headers = {**headers, "Content-Type": "image/webp"}
                return client.request(method, path, headers=headers, content=context["avatar_bytes"])
            elif name == "clearAvatar":
                pass
            elif name == "redeemInviteCode":
                body = {"code": "not-needed-for-member"}
            elif name == "createPost":
                body = {"title": "Created by contract", "body": "New content", "is_anonymous": True}
            elif name == "updatePost":
                body = {"title": "Updated contract discussion", "body": "Parity body updated"}
            elif name == "deletePost":
                values["post_id"] = context["created_post_id"]
                path = action["path"].format(**values)
            elif name == "createReply":
                body = {"body": "Created reply", "is_anonymous": False, "parent_reply_id": None}
            elif name == "updateReply":
                values["reply_id"] = context["created_reply_id"]
                path = action["path"].format(**values)
                body = {"body": "Updated created reply"}
            elif name == "deleteReply":
                values["reply_id"] = context["created_reply_id"]
                path = action["path"].format(**values)
            elif name == "createFeedback":
                body = {"body": "Contract feedback"}
            elif name in {"toggleReplyVote", "togglePostVote"}:
                pass
            elif name == "adminDeleteContent":
                pass
            elif name == "getProfile":
                values["public_id"] = context["member_public_id"]
                path = action["path"].format(**values)
            return client.request(method, path, headers=headers, json=body)

        calls = []
        for action in CONTRACT["actions"]:
            if action["name"] == "deletePost":
                assert context["created_post_id"] is not None
            if action["name"] == "createPost":
                response = request_for(action)
                assert_response_shape(action, response)
                context["created_post_id"] = db.posts.find_one({"title": "Created by contract"})["id"]
            elif action["name"] == "createReply":
                response = request_for(action)
                assert_response_shape(action, response)
                context["created_reply_id"] = db.replies.find_one(
                    {"post_id": main_post_id, "body": "Created reply"}
                )["id"]
            else:
                response = request_for(action)
                assert_response_shape(action, response)
            if action["name"] == "adminSetDisabled":
                db.members.update_one({"user_id": "contract-member"}, {"$set": {"is_disabled": False}})
            if action["name"] == "uploadAvatar":
                context["uploaded_avatar_id"] = response.json()["avatar_url"]
            calls.append(action["name"])

        assert calls == [action["name"] for action in CONTRACT["actions"]]
        assert context["uploaded_avatar_id"]
        assert db.feedback.count_documents({"user_id": "contract-owner", "body": "Contract feedback"}) == 1


def test_anonymous_op_identity_and_reply_reparenting_match_legacy_rules(db):
    with TestClient(create_app(db)) as client:
        owner = join(client, db, "privacy-owner")
        other = join(client, db, "privacy-other")
        created = client.post(
            "/api/posts",
            headers=owner,
            json={"title": "Anonymous question", "body": "Private identity", "is_anonymous": True},
        )
        assert created.status_code == 201, created.text
        post_id = db.posts.find_one({"author_id": "privacy-owner"})["id"]
        for body, headers, anonymous in (
            ("matching anonymous OP reply", owner, True),
            ("named same author reply", owner, False),
            ("matching anonymous other reply", other, True),
        ):
            response = client.post(
                f"/api/posts/{post_id}/replies",
                headers=headers,
                json={"body": body, "is_anonymous": anonymous},
            )
            assert response.status_code == 201, response.text
        detail = client.get(f"/api/posts/{post_id}", headers=other).json()
        replies = {reply["body"]: reply for reply in detail["replies"]}
        assert detail["author_name"] == "匿名成员"
        assert "author_id" not in detail
        assert replies["matching anonymous OP reply"]["is_op"] is True
        assert replies["named same author reply"]["is_op"] is False
        assert replies["matching anonymous other reply"]["is_op"] is False
        assert all("author_id" not in reply for reply in detail["replies"])

        parent_id = db.replies.find_one({"post_id": post_id, "body": "matching anonymous OP reply"})["id"]
        child = client.post(
            f"/api/posts/{post_id}/replies",
            headers=other,
            json={"body": "Nested child", "is_anonymous": True, "parent_reply_id": parent_id},
        )
        assert child.status_code == 201, child.text
        child_id = db.replies.find_one({"body": "Nested child"})["id"]
        assert client.delete(f"/api/replies/{parent_id}", headers=other).status_code == 404
        assert client.delete(f"/api/replies/{parent_id}", headers=owner).status_code == 200
        assert db.replies.find_one({"id": child_id})["parent_reply_id"] is None
        assert (
            client.patch(
                f"/api/posts/{post_id}", headers=other, json={"title": "Hijack", "body": "x"}
            ).status_code
            == 404
        )


def test_search_uses_literal_case_insensitive_substrings_and_caps_newest_results(db):
    with TestClient(create_app(db)) as client:
        owner = join(client, db, "search-owner")
        other = join(client, db, "search-other")
        for index in range(55):
            response = client.post(
                "/api/posts",
                headers=owner,
                json={
                    "title": f"LimitNeedle {index:02d}",
                    "body": "普通话正文",
                    "is_anonymous": index == 54,
                },
            )
            assert response.status_code == 201, response.text

        latest_id = db.posts.find_one({"author_id": "search-owner", "title": "LimitNeedle 54"})["id"]
        for index in range(55):
            db.posts.update_one(
                {"author_id": "search-owner", "title": f"LimitNeedle {index:02d}"},
                {
                    "$set": {
                        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=index)
                    }
                },
            )
        assert (
            client.post(
                f"/api/posts/{latest_id}/replies",
                headers=owner,
                json={"body": "Anonymous OP reply", "is_anonymous": True},
            ).status_code
            == 201
        )
        assert client.post(f"/api/posts/{latest_id}/vote", headers=other).status_code == 200
        results = client.get("/api/posts/search?q=LiMiTnEeDl", headers=other)
        assert results.status_code == 200, results.text
        found = results.json()
        assert len(found) == 50
        assert found[0]["id"] == latest_id
        assert all("replies" in post for post in found)
        assert found[0]["author_name"] == "匿名成员"
        assert "author_id" not in found[0]
        assert found[0]["liked_by_me"] is True
        assert found[0]["is_mine"] is False
        assert found[0]["replies"][0]["is_op"] is True
        assert found[0]["replies"][0]["is_mine"] is False
        assert "author_id" not in found[0]["replies"][0]

        # Query wildcards and regex syntax are plain characters, and CJK
        # substrings use the same path as Latin text.
        literal = client.post(
            "/api/posts",
            headers=owner,
            json={"title": "Symbol %_ [x]", "body": "你好世界", "is_anonymous": True},
        )
        assert literal.status_code == 201, literal.text
        assert len(client.get("/api/posts/search?q=%25_", headers=other).json()) == 1
        assert len(client.get("/api/posts/search", params={"q": "[x]"}, headers=other).json()) == 1
        assert client.get("/api/posts/search", params={"q": ".*"}, headers=other).json() == []
        assert len(client.get("/api/posts/search?q=%E4%BD%A0%E5%A5%BD", headers=other).json()) == 1
        assert client.get("/api/posts/search?q=%20%20%20", headers=other).json() == []
        assert client.get("/api/posts/search?q=" + "x" * 101, headers=other).json() == []

        assert client.get("/api/posts/search?q=needle").status_code == 401
        db.members.update_one({"user_id": "search-other"}, {"$set": {"is_disabled": True}})
        assert client.get("/api/posts/search?q=needle", headers=other).status_code == 403


def test_list_mine_returns_only_callers_owned_content_and_hides_identity(db):
    with TestClient(create_app(db)) as client:
        owner = join(client, db, "mine-owner")
        other = join(client, db, "mine-other")
        post_response = client.post(
            "/api/posts",
            headers=owner,
            json={"title": "My anonymous post", "body": "post body", "is_anonymous": True},
        )
        assert post_response.status_code == 201, post_response.text
        post_id = db.posts.find_one({"author_id": "mine-owner"})["id"]
        assert (
            client.post("/api/posts", headers=other, json={"title": "Their post", "body": "x"}).status_code
            == 201
        )
        own_reply = client.post(
            f"/api/posts/{post_id}/replies",
            headers=owner,
            json={"body": "My anonymous reply", "is_anonymous": True},
        )
        assert own_reply.status_code == 201, own_reply.text
        reply_id = db.replies.find_one({"author_id": "mine-owner"})["id"]

        response = client.get("/api/me/content", headers=owner)
        assert response.status_code == 200, response.text
        mine = response.json()
        assert [post["id"] for post in mine["posts"]] == [post_id]
        assert [reply["id"] for reply in mine["replies"]] == [reply_id]
        assert mine["posts"][0]["title"] == "My anonymous post"
        assert mine["posts"][0]["is_anonymous"] is True
        assert mine["replies"][0]["post_title"] == "My anonymous post"
        assert mine["replies"][0]["body"] == "My anonymous reply"
        assert all(
            "author_id" not in item and "author_name" not in item for group in mine.values() for item in group
        )

        assert client.get("/api/me/content").status_code == 401
        db.members.update_one({"user_id": "mine-owner"}, {"$set": {"is_disabled": True}})
        assert client.get("/api/me/content", headers=owner).status_code == 403


def test_list_mine_limits_each_group_to_100_newest_and_excludes_other_authors(db):
    with TestClient(create_app(db)) as client:
        owner = join(client, db, "bounded-owner")
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        db.posts.insert_many(
            [
                {
                    "id": index,
                    "author_id": "bounded-owner",
                    "title": f"Post {index}",
                    "created_at": base + timedelta(seconds=index),
                    "is_anonymous": index % 2 == 0,
                }
                for index in range(1, 106)
            ]
        )
        db.replies.insert_many(
            [
                {
                    "id": index,
                    "post_id": 1,
                    "author_id": "bounded-owner",
                    "body": f"Reply {index}",
                    "created_at": base + timedelta(seconds=index),
                    "is_anonymous": index % 2 == 0,
                }
                for index in range(1, 106)
            ]
        )
        db.posts.insert_one(
            {
                "id": 999,
                "author_id": "another-user",
                "title": "Other's post",
                "created_at": base + timedelta(days=1),
            }
        )
        db.replies.insert_one(
            {
                "id": 999,
                "post_id": 1,
                "author_id": "another-user",
                "body": "Other's reply",
                "created_at": base + timedelta(days=1),
            }
        )
        response = client.get("/api/me/content", headers=owner)
        assert response.status_code == 200, response.text
        mine = response.json()
        assert [item["id"] for item in mine["posts"]] == list(range(105, 5, -1))
        assert [item["id"] for item in mine["replies"]] == list(range(105, 5, -1))
        assert set(mine["posts"][0]) == {"id", "title", "created_at", "is_anonymous"}
        assert set(mine["replies"][0]) == {
            "id",
            "post_id",
            "body",
            "created_at",
            "is_anonymous",
            "post_title",
        }
