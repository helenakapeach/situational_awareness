from fastapi import APIRouter, Depends

from ..dependencies import current_user, database
from .models import DisabledUpdate, InviteCode
from .service import MembershipService

router = APIRouter(tags=["membership"])


def get_service(db=Depends(database), user=Depends(current_user)):
    return MembershipService(db, user)


@router.get("/member-access")
def member_access(svc=Depends(get_service)):
    return svc.member_access()


@router.post("/invite-redemptions")
def redeem(payload: InviteCode, svc=Depends(get_service)):
    return svc.redeem_invite_code(payload.code)


@router.get("/admin/members")
def admin_members(svc=Depends(get_service)):
    return svc.admin_members()


@router.patch("/admin/members/{user_id}")
def disable(user_id: str, payload: DisabledUpdate, svc=Depends(get_service)):
    return svc.admin_set_disabled(user_id, payload.is_disabled)
