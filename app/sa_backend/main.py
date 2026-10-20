import warnings
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pymongo import MongoClient
from pymongo.errors import PyMongoError

from .auth import create_app_session_token, current_claims, verify_identity
from .config import get_settings
from .models import (
    DisabledUpdate,
    Feedback,
    InviteCode,
    PostCreate,
    PostUpdate,
    ProfileUpdate,
    ReplyCreate,
    ReplyUpdate,
    SessionRequest,
    VerificationUpdate,
)
from .sandbox import reset_sandbox, sandbox_database_name, sandbox_ready
from .services import BackendService, bootstrap_indexes


def database(request: Request):
    return request.app.state.db


def current_user(db=Depends(database), claims: dict = Depends(current_claims)):
    user = db.users.find_one({"id": claims["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User no longer exists")
    return user


def service(db=Depends(database), user=Depends(current_user)):
    return BackendService(db, user)


def create_app(db=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        settings = get_settings()
        client = None
        try:
            if db is None:
                client = MongoClient(settings.mongodb_uri, tz_aware=True, serverSelectionTimeoutMS=5000)
                hello = await run_in_threadpool(client.admin.command, "hello")
                if not hello.get("setName") and hello.get("msg") != "isdbgrid":
                    raise RuntimeError("MongoDB must be a replica set or mongos: transactions are required")
                application.state.db = client[settings.mongodb_database]
                application.state.sandbox_generation = await run_in_threadpool(
                    reset_sandbox, application.state.db, settings
                )
                application.state.db = client[sandbox_database_name(application.state.sandbox_generation)]
            else:
                application.state.db = db
            await run_in_threadpool(bootstrap_indexes, application.state.db)
            yield
        finally:
            if client is not None:
                client.close()

    application = FastAPI(title="Situational Awareness API", version="0.1.0", lifespan=lifespan)

    # The factory reads settings; importing this module needs no configured secrets.
    @application.middleware("http")
    async def security_headers(request: Request, call_next):
        generation = getattr(request.app.state, "sandbox_generation", None)
        if generation and not await run_in_threadpool(sandbox_ready, request.app.state.db, generation):
            # Old revisions must stop serving when a new startup resets the shared sandbox.
            return Response(
                status_code=503, content="Mongo sandbox is restarting", headers={"Cache-Control": "no-store"}
            )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # CORSMiddleware has to be registered before the ASGI application starts.
    # Factory callers provide settings via env; tests use the same explicit configuration.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @application.get("/health")
    def health(db=Depends(database)):
        try:
            db.command("ping")
        except PyMongoError as exc:
            raise HTTPException(503, "MongoDB unavailable") from exc
        return {"status": "ok"}

    @application.post("/api/auth/session")
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

    @application.get("/api/auth/me")
    def me(user=Depends(current_user)):
        return {"id": user["id"], "email": user["email"], "user_metadata": user.get("user_metadata", {})}

    @application.get("/api/member-access")
    def member_access(svc=Depends(service)):
        return svc.member_access()

    @application.post("/api/invite-redemptions")
    def redeem(payload: InviteCode, svc=Depends(service)):
        return svc.redeem_invite_code(payload.code)

    @application.get("/api/profile")
    def own_profile(svc=Depends(service)):
        return svc.get_own_profile()

    @application.put("/api/profile")
    def update_profile(payload: ProfileUpdate, svc=Depends(service)):
        return svc.update_own_profile(payload.model_dump())

    @application.get("/api/profiles/{public_id}")
    def profile(public_id: str, svc=Depends(service)):
        try:
            return svc.get_profile(public_id)
        except HTTPException as error:
            # The legacy get_profile RPC returns null for absent/disabled targets.
            if error.status_code == 404:
                return None
            raise

    @application.get("/api/cohorts")
    def cohorts(svc=Depends(service)):
        return svc.list_cohorts()

    @application.post("/api/profile/avatar")
    async def upload_avatar(request: Request, svc=Depends(service)):
        if request.headers.get("content-type", "").split(";")[0] != "image/webp":
            raise HTTPException(415, "Avatar must be image/webp")
        # Bound streamed bodies too; Content-Length alone is not trustworthy.
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

    @application.delete("/api/profile/avatar")
    def clear_avatar(svc=Depends(service)):
        return svc.clear_avatar()

    @application.get("/storage/v1/object/public/avatars/{avatar_id}")
    def avatar(avatar_id: str, db=Depends(database)):
        # Compatibility with displayAvatarUrl(); public images have unguessable names.
        row = db.avatars.find_one({"id": avatar_id})
        if not row:
            raise HTTPException(404, "Avatar not found")
        return Response(
            bytes(row["data"]), media_type="image/webp", headers={"Cache-Control": "public, max-age=3600"}
        )

    @application.get("/api/posts")
    def posts(
        before: datetime | None = None,
        before_id: int | None = Query(default=None, gt=0),
        svc=Depends(service),
    ):
        if before is not None:
            if before.tzinfo is None:
                raise HTTPException(422, "before must include a timezone")
            before = before.astimezone(timezone.utc)
        return svc.list_posts(before=before, before_id=before_id)

    @application.get("/api/posts/{post_id}")
    def post(post_id: int, svc=Depends(service)):
        result = svc.get_post(post_id)
        if result is None:
            raise HTTPException(404, "Post not found")
        return result

    @application.post("/api/posts", status_code=201)
    def create_post(payload: PostCreate, svc=Depends(service)):
        return svc.create_post(payload.model_dump())

    @application.patch("/api/posts/{post_id}")
    def update_post(post_id: int, payload: PostUpdate, svc=Depends(service)):
        return svc.update_post(post_id, payload.model_dump())

    @application.delete("/api/posts/{post_id}")
    def delete_post(post_id: int, svc=Depends(service)):
        return svc.delete_post(post_id)

    @application.post("/api/posts/{post_id}/replies", status_code=201)
    def create_reply(post_id: int, payload: ReplyCreate, svc=Depends(service)):
        return svc.create_reply(post_id, payload.model_dump())

    @application.patch("/api/replies/{reply_id}")
    def update_reply(reply_id: int, payload: ReplyUpdate, svc=Depends(service)):
        return svc.update_reply(reply_id, payload.body)

    @application.delete("/api/replies/{reply_id}")
    def delete_reply(reply_id: int, svc=Depends(service)):
        return svc.delete_reply(reply_id)

    @application.post("/api/posts/{post_id}/vote")
    def post_vote(post_id: int, svc=Depends(service)):
        return svc.toggle_post_vote(post_id)

    @application.post("/api/replies/{reply_id}/vote")
    def reply_vote(reply_id: int, svc=Depends(service)):
        return svc.toggle_reply_vote(reply_id)

    @application.get("/api/likes")
    def likes(svc=Depends(service)):
        return svc.list_liked()

    @application.post("/api/feedback", status_code=201)
    def feedback(payload: Feedback, svc=Depends(service)):
        return svc.create_feedback(payload.model_dump())

    @application.get("/api/admin/members")
    def admin_members(svc=Depends(service)):
        return svc.admin_members()

    @application.patch("/api/admin/members/{user_id}")
    def disable(user_id: str, payload: DisabledUpdate, svc=Depends(service)):
        return svc.admin_set_disabled(user_id, payload.is_disabled)

    @application.put("/api/admin/members/{user_id}/role-verification")
    def verify_role(user_id: str, payload: VerificationUpdate, svc=Depends(service)):
        return svc.admin_set_role_verified(user_id, payload.verified)

    @application.delete("/api/admin/content/{kind}/{content_id}")
    def moderate(kind: Literal["post", "reply"], content_id: int, svc=Depends(service)):
        return svc.admin_delete_content(content_id, kind)

    return application
