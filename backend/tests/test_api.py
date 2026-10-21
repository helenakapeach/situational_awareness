from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth.service import create_app_session_token
from app.config import get_settings
from app.main import create_app


@pytest.fixture
def client(db):
    with TestClient(create_app(db)) as test_client:
        yield test_client


def headers(db, user_id="user-1", email="user@example.com"):
    user = {"id": user_id, "email": email, "user_metadata": {"full_name": "Test User"}}
    db.users.update_one({"id": user_id}, {"$set": user}, upsert=True)
    return {"Authorization": "Bearer " + create_app_session_token(user, get_settings())}


def join(client, db, user_id="user-1"):
    auth = headers(db, user_id)
    db.invite_codes.update_one(
        {"code": "JOIN"},
        {
            "$setOnInsert": {
                "code": "JOIN",
                "is_active": True,
                "used_count": 0,
                "max_uses": None,
            }
        },
        upsert=True,
    )
    response = client.post("/api/invite-redemptions", json={"code": "join"}, headers=auth)
    assert response.status_code == 200, response.text
    assert response.json() is True
    return auth


def test_route_auth_and_identity_exchange(client, db, monkeypatch):
    assert client.get("/health").status_code == 200
    assert client.get("/api/posts").status_code == 401
    assert client.post("/api/auth/session", json={}).status_code == 422

    def get(url, **kwargs):
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={
                "id": "new-google-user",
                "email": "GOOGLE@EXAMPLE.COM",
                "email_confirmed_at": "2026-01-01",
                "app_metadata": {"provider": "google"},
                "user_metadata": {"full_name": "Google User"},
            },
        )

    monkeypatch.setattr("app.auth.service.httpx.get", get)
    response = client.post("/api/auth/session", json={"access_token": "verified-by-provider"})
    assert response.status_code == 200, response.text
    data = response.json()
    auth = {"Authorization": "Bearer " + data["accessToken"]}
    assert client.get("/api/auth/me", headers=auth).json()["email"] == "google@example.com"
    assert client.get("/api/member-access", headers=auth).json()["is_member"] is False
    assert client.get("/api/posts", headers=auth).status_code == 403
    assert db.members.count_documents({}) == 0  # Sign-in never bypasses invitation.


def test_post_reply_vote_likes_feedback_and_permission_contract(client, db):
    auth = join(client, db)
    other = join(client, db, "user-2")
    response = client.post(
        "/api/posts", json={"title": " First question ", "body": " Context "}, headers=auth
    )
    assert response.status_code == 201, response.text
    posts = client.get("/api/posts", headers=auth).json()
    post = posts[0]
    assert post["title"] == "First question"
    assert post["is_mine"] is True
    assert post["is_anonymous"] is True
    assert "author_id" not in post and "_id" not in post
    post_id = post["id"]
    assert (
        client.patch(
            f"/api/posts/{post_id}", headers=other, json={"title": "Hijack", "body": "x"}
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/api/posts/{post_id}", headers=auth, json={"title": "Updated", "body": "Updated"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/posts/{post_id}",
            headers=auth,
            json={"title": "Updated", "body": "Updated", "is_anonymous": False},
        ).status_code
        == 422
    )
    response = client.post(f"/api/posts/{post_id}/replies", headers=other, json={"body": "A reply"})
    assert response.status_code == 201, response.text
    detail = client.get(f"/api/posts/{post_id}", headers=auth).json()
    reply = detail["replies"][0]
    assert reply["is_mine"] is False and reply["is_op"] is False
    rid = reply["id"]
    assert (
        client.patch(f"/api/replies/{rid}", headers=other, json={"body": "Edited reply"}).status_code == 200
    )
    assert client.post(f"/api/posts/{post_id}/vote", headers=other).status_code == 200
    assert client.post(f"/api/replies/{rid}/vote", headers=auth).status_code == 200
    assert client.get(f"/api/posts/{post_id}", headers=other).json()["liked_by_me"] is True
    assert client.get("/api/likes", headers=other).json()["posts"][0]["id"] == post_id
    assert client.get("/api/likes", headers=auth).json()["replies"][0]["post_title"] == "Updated"
    assert client.post("/api/feedback", headers=auth, json={"body": "Feedback"}).status_code == 201
    assert db.feedback.count_documents({}) == 1
    assert client.get("/api/feedback", headers=auth).status_code == 405
    assert client.delete(f"/api/replies/{rid}", headers=auth).status_code == 404
    assert client.delete(f"/api/replies/{rid}", headers=other).status_code == 200
    assert client.delete(f"/api/posts/{post_id}", headers=auth).status_code == 200
    assert client.get(f"/api/posts/{post_id}", headers=auth).status_code == 404


def test_profiles_avatar_and_admin_contract(client, db):
    auth = join(client, db)
    other = join(client, db, "user-2")
    assert client.get("/api/cohorts", headers=auth).json()[0]["name"] == "创业"
    response = client.put(
        "/api/profile",
        headers=auth,
        json={
            "display_name": "Named Person",
            "role": "student",
            "cohort_id": 1,
            "contact_email": "PRIVATE@EXAMPLE.COM",
            "email_public": False,
        },
    )
    assert response.status_code == 200, response.text
    profile = response.json()
    assert profile["is_self"] is True and profile["cohort_name"] == "创业"
    card = client.get(f"/api/profiles/{profile['public_id']}", headers=other).json()
    assert "contact_email" not in card and "user_id" not in card
    missing = client.get("/api/profiles/missing-public-id", headers=other)
    assert missing.status_code == 200 and missing.json() is None
    assert (
        client.put(
            "/api/profile", headers=auth, json={"display_name": "Name", "role_verified": True}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/profile/avatar", headers={**auth, "Content-Type": "image/webp"}, content=b"fake"
        ).status_code
        == 422
    )
    image = BytesIO()
    Image.new("RGB", (256, 256), "white").save(image, format="WEBP")
    response = client.post(
        "/api/profile/avatar", headers={**auth, "Content-Type": "image/webp"}, content=image.getvalue()
    )
    assert response.status_code == 200, response.text
    uploaded_profile = response.json()
    assert uploaded_profile["display_name"] == "Named Person"
    image_url = f"/storage/v1/object/public/avatars/{uploaded_profile['avatar_url']}"
    assert client.get(image_url).content == image.getvalue()
    cleared = client.delete("/api/profile/avatar", headers=auth)
    assert cleared.status_code == 200 and cleared.json()["display_name"] == "Named Person"
    assert client.get(image_url).status_code == 404
    assert client.get("/api/admin/members", headers=auth).status_code == 403
    db.members.update_one({"user_id": "user-1"}, {"$set": {"is_admin": True}})
    assert len(client.get("/api/admin/members", headers=auth).json()) == 2
    assert (
        client.put(
            "/api/admin/members/user-1/role-verification", headers=auth, json={"verified": True}
        ).status_code
        == 200
    )
    assert client.get("/api/profile", headers=auth).json()["role_verified"] is True
    assert (
        client.put(
            "/api/admin/members/user-2/role-verification", headers=auth, json={"verified": True}
        ).status_code
        == 400
    )
    assert (
        client.patch("/api/admin/members/user-1", headers=auth, json={"is_disabled": True}).status_code == 400
    )
    assert (
        client.patch("/api/admin/members/user-2", headers=auth, json={"is_disabled": True}).status_code == 200
    )
    assert client.get("/api/posts", headers=other).status_code == 403
    disabled_profile = db.profiles.find_one({"user_id": "user-2"})
    hidden = client.get(f"/api/profiles/{disabled_profile['public_id']}", headers=auth)
    assert hidden.status_code == 200 and hidden.json() is None
    assert client.get("/api/member-access", headers=other).json()["is_disabled"] is True
    assert client.get(f"/api/profiles/{profile['public_id']}", headers=other).status_code == 403
    assert (
        client.patch("/api/admin/members/user-2", headers=auth, json={"is_disabled": False}).status_code
        == 200
    )
    client.post("/api/posts", headers=other, json={"title": "Moderation", "body": "body"})
    post_id = client.get("/api/posts", headers=auth).json()[0]["id"]
    assert client.delete(f"/api/admin/content/post/{post_id}", headers=auth).status_code == 200


def test_validation_and_cors(client, db):
    auth = join(client, db)
    assert client.post("/api/posts", headers=auth, json={"title": "valid", "body": " "}).status_code == 422
    assert client.get("/api/posts?before=2026-01-01T00:00:00", headers=auth).status_code == 422
    response = client.options(
        "/api/posts", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"}
    )
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_real_app_startup_connects_to_replica_set(db, monkeypatch):
    from app import main

    monkeypatch.setenv("MONGODB_DATABASE", db.name)
    # Test the real replica-set connection without resetting a fixture database.
    # The full reset hook and its source import have dedicated sandbox integration tests.
    monkeypatch.setattr(main, "reset_sandbox", lambda *_args: None)
    get_settings.cache_clear()
    with TestClient(create_app()) as production_app:
        assert production_app.get("/health").json() == {"status": "ok"}
