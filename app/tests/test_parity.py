"""Contract-driven checks shared with the frontend's Supabase-compatible adapter."""

import json
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
    elif kind == "likes":
        assert isinstance(value, dict) and set(value) == {"posts", "replies"}
        assert isinstance(value["posts"], list) and isinstance(value["replies"], list)
    else:
        pytest.fail(f"Unknown response contract: {kind}")


def test_manifest_covers_all_non_deprecated_actions():
    assert len(CONTRACT["actions"]) == 23
    assert len({action["name"] for action in CONTRACT["actions"]}) == 23
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
