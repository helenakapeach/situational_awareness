from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..dependencies import current_user, database
from .models import Feedback, PostCreate, PostUpdate, ReplyCreate, ReplyUpdate
from .service import ForumService

router = APIRouter(tags=["forum"])


def get_service(db=Depends(database), user=Depends(current_user)):
    return ForumService(db, user)


@router.get("/posts")
def posts(
    before: datetime | None = None,
    before_id: int | None = Query(default=None, gt=0),
    svc=Depends(get_service),
):
    if before is not None:
        if before.tzinfo is None:
            raise HTTPException(422, "before must include a timezone")
        before = before.astimezone(timezone.utc)
    return svc.list_posts(before=before, before_id=before_id)


@router.get("/posts/search")
def search_posts(q: str = "", svc=Depends(get_service)):
    return svc.search_posts(q)


@router.get("/me/content")
def my_content(svc=Depends(get_service)):
    return svc.list_mine()


@router.get("/likes")
def likes(svc=Depends(get_service)):
    return svc.list_liked()


@router.post("/feedback", status_code=201)
def feedback(payload: Feedback, svc=Depends(get_service)):
    return svc.create_feedback(payload.model_dump())


@router.get("/posts/{post_id}")
def post(post_id: int, svc=Depends(get_service)):
    result = svc.get_post(post_id)
    if result is None:
        raise HTTPException(404, "Post not found")
    return result


@router.post("/posts", status_code=201)
def create_post(payload: PostCreate, svc=Depends(get_service)):
    return svc.create_post(payload.model_dump())


@router.patch("/posts/{post_id}")
def update_post(post_id: int, payload: PostUpdate, svc=Depends(get_service)):
    return svc.update_post(post_id, payload.model_dump())


@router.delete("/posts/{post_id}")
def delete_post(post_id: int, svc=Depends(get_service)):
    return svc.delete_post(post_id)


@router.post("/posts/{post_id}/replies", status_code=201)
def create_reply(post_id: int, payload: ReplyCreate, svc=Depends(get_service)):
    return svc.create_reply(post_id, payload.model_dump())


@router.patch("/replies/{reply_id}")
def update_reply(reply_id: int, payload: ReplyUpdate, svc=Depends(get_service)):
    return svc.update_reply(reply_id, payload.body)


@router.delete("/replies/{reply_id}")
def delete_reply(reply_id: int, svc=Depends(get_service)):
    return svc.delete_reply(reply_id)


@router.post("/posts/{post_id}/vote")
def post_vote(post_id: int, svc=Depends(get_service)):
    return svc.toggle_post_vote(post_id)


@router.post("/replies/{reply_id}/vote")
def reply_vote(reply_id: int, svc=Depends(get_service)):
    return svc.toggle_reply_vote(reply_id)


@router.delete("/admin/content/{kind}/{content_id}")
def moderate(kind: Literal["post", "reply"], content_id: int, svc=Depends(get_service)):
    return svc.admin_delete_content(content_id, kind)
