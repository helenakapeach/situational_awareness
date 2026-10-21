from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from pymongo.errors import PyMongoError

from .auth.router import router as auth_router
from .config import get_settings
from .database import bootstrap_indexes
from .dependencies import database
from .forum.router import router as forum_router
from .membership.router import router as membership_router
from .profile.router import assets_router
from .profile.router import router as profile_router
from .sandbox import reset_sandbox

API_PREFIX = "/api"


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
                await run_in_threadpool(reset_sandbox, application.state.db, settings)
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
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path.startswith(f"{API_PREFIX}/"):
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

    for router in (auth_router, membership_router, profile_router, forum_router):
        application.include_router(router, prefix=API_PREFIX)
    application.include_router(assets_router)
    return application
