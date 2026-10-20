from fastapi import APIRouter, Depends

from ..config import get_settings
from ..dependencies import current_user, database
from .models import SessionRequest
from .service import create_app_session_token, verify_identity

router = APIRouter(tags=["auth"])


@router.post("/auth/session")
def create_session(payload: SessionRequest, db=Depends(database)):
    settings = get_settings()
    user = verify_identity(payload, settings)
    db.users.update_one({"id": user["id"]}, {"$set": user}, upsert=True)
    return {
        "accessToken": create_app_session_token(user, settings),
        "tokenType": "Bearer",
        "expiresIn": settings.app_session_ttl_seconds,
        "user": user,
    }


@router.get("/auth/me")
def me(user=Depends(current_user)):
    return {"id": user["id"], "email": user["email"], "user_metadata": user.get("user_metadata", {})}
