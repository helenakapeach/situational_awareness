import pytest
from fastapi import HTTPException

from sa_backend.services import BackendService


class Collection:
    def __init__(self, document=None):
        self.documents = document if isinstance(document, list) else ([document] if document else [])

    def find_one(self, query, projection=None, **kwargs):
        return next((doc for doc in self.documents if all(doc.get(k) == v for k, v in query.items())), None)


class Database:
    def __init__(self, *, member=None, profile=None):
        self.members = Collection(member)
        self.profiles = Collection(profile)


def test_profile_card_exposes_only_public_contact_fields():
    profile = {
        "user_id": "private-user-id",
        "public_id": "public-id",
        "display_name": "A Person",
        "tagline": "Hello",
        "bio": "Bio",
        "avatar_url": "",
        "role": "mentor",
        "cohort_name": None,
        "graduation_year": None,
        "role_verified": True,
        "linkedin_url": "https://www.linkedin.com/in/person",
        "linkedin_public": True,
        "contact_email": "private@example.com",
        "email_public": False,
        "wechat_id": "PrivateWeChat",
        "wechat_public": False,
    }
    service = BackendService(
        Database(member=[{"user_id": "viewer"}, {"user_id": "private-user-id"}], profile=profile),
        {"id": "viewer"},
    )

    card = service.get_profile("public-id")

    assert card["linkedin_url"] == profile["linkedin_url"]
    assert "contact_email" not in card
    assert "wechat_id" not in card
    assert "user_id" not in card


def test_anonymous_identity_contains_no_profile_reference():
    service = BackendService(Database(member={"user_id": "viewer"}), {"id": "viewer"})

    identity = service._identity(None)

    assert identity == {
        "author_name": "匿名成员",
        "author_avatar_url": "",
        "author_public_id": None,
        "author_role": None,
        "author_cohort_name": None,
        "author_role_verified": False,
    }


def test_disabled_member_cannot_read_member_data():
    service = BackendService(Database(member={"user_id": "viewer", "is_disabled": True}), {"id": "viewer"})

    with pytest.raises(HTTPException) as error:
        service.get_own_profile()

    assert error.value.status_code == 403


def test_admin_methods_require_an_active_admin():
    service = BackendService(Database(member={"user_id": "viewer", "is_admin": False}), {"id": "viewer"})

    with pytest.raises(HTTPException) as error:
        service.admin_members()

    assert error.value.status_code == 403
