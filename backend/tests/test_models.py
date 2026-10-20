import pytest
from pydantic import ValidationError

from app.models import PostCreate, PostUpdate, ProfileUpdate, ReplyCreate, SessionRequest


def test_payload_normalization_and_safe_field_allowlists():
    assert PostCreate(title="  Valid title  ", body=" body ").model_dump() == {
        "title": "Valid title",
        "body": "body",
        "is_anonymous": True,
    }
    with pytest.raises(ValidationError):
        PostUpdate(title="valid", body="body", author_id="attacker")
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="Name", role_verified=True)
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="Name", avatar_url="arbitrary")
    with pytest.raises(ValidationError):
        ReplyCreate(body="body", parent_reply_id=-1)


@pytest.mark.parametrize(
    "values",
    [
        {"title": "  ", "body": "body"},
        {"title": "valid", "body": "  "},
        {"title": "valid", "body": "a" * 4001},
    ],
)
def test_invalid_posts_rejected(values):
    with pytest.raises(ValidationError):
        PostCreate(**values)


def test_profile_contact_rules_and_role_normalization():
    profile = ProfileUpdate(
        display_name=" Name ",
        linkedin_url="www.linkedin.com/in/person",
        contact_email="USER@EXAMPLE.COM",
        email_public=True,
        role="mentor",
        cohort_id=1,
        graduation_year=2026,
    )
    assert profile.linkedin_url == "https://www.linkedin.com/in/person"
    assert profile.contact_email == "user@example.com"
    assert profile.cohort_id is None
    assert profile.graduation_year is None
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="Name\nBreak")
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="Name", wechat_id="bad space")
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="Name", linkedin_url="https://evil.test/person")


def test_exchange_requires_correct_provider_token():
    with pytest.raises(ValidationError):
        SessionRequest()
    with pytest.raises(ValidationError):
        SessionRequest(provider="auth0", access_token="wrong-type")
