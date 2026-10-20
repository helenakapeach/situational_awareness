"""HTTP routes for profiles and public avatar objects."""

import warnings
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError

from ..dependencies import current_user, database
from .models import ProfileUpdate, VerificationUpdate
from .service import ProfileService

router = APIRouter(tags=["profile"])
assets_router = APIRouter(tags=["profile-assets"])


def get_service(db=Depends(database), user=Depends(current_user)):
    return ProfileService(db, user)


@router.get("/profile")
def own_profile(svc=Depends(get_service)):
    return svc.get_own_profile()


@router.put("/profile")
def update_profile(payload: ProfileUpdate, svc=Depends(get_service)):
    return svc.update_own_profile(payload.model_dump())


@router.get("/profiles/{public_id}")
def profile(public_id: str, svc=Depends(get_service)):
    try:
        return svc.get_profile(public_id)
    except HTTPException as error:
        # The legacy get_profile RPC returns null for absent/disabled targets.
        if error.status_code == 404:
            return None
        raise


@router.get("/cohorts")
def cohorts(svc=Depends(get_service)):
    return svc.list_cohorts()


@router.post("/profile/avatar")
async def upload_avatar(request: Request, svc=Depends(get_service)):
    if request.headers.get("content-type", "").split(";")[0] != "image/webp":
        raise HTTPException(415, "Avatar must be image/webp")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 1024 * 1024:
            raise HTTPException(413, "Avatar cannot exceed 1MB")

    def validate_and_save():
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(data)) as image:
                    if image.format != "WEBP" or image.size != (256, 256):
                        raise HTTPException(422, "Avatar must be a 256x256 WebP")
                    image.verify()
        except (
            UnidentifiedImageError,
            OSError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise HTTPException(422, "Invalid WebP image") from exc
        return svc.upload_avatar(bytes(data))

    return await run_in_threadpool(validate_and_save)


@router.delete("/profile/avatar")
def clear_avatar(svc=Depends(get_service)):
    return svc.clear_avatar()


@router.put("/admin/members/{user_id}/role-verification")
def verify_role(user_id: str, payload: VerificationUpdate, svc=Depends(get_service)):
    return svc.admin_set_role_verified(user_id, payload.verified)


@assets_router.get("/storage/v1/object/public/avatars/{avatar_id}")
def avatar(avatar_id: str, db=Depends(database)):
    # Compatibility with displayAvatarUrl(); public images have unguessable names.
    row = db.avatars.find_one({"id": avatar_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "Avatar not found")
    return Response(
        bytes(row["data"]), media_type="image/webp", headers={"Cache-Control": "public, max-age=3600"}
    )
