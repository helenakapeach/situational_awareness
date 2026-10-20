"""Rebuild the disposable Mongo stack from a read-only Supabase snapshot at startup."""

import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from uuid import uuid4

from pymongo.errors import DuplicateKeyError, PyMongoError

from .migration import import_bundle, load_bundle
from .supabase_dump import export_from_postgres

SANDBOX_DATABASE = "linghang_main_app_sandbox"
CONTROL_DATABASE = "linghang_main_app_sandbox_control"
LEASE_SECONDS = 90
logger = logging.getLogger(__name__)


def _state(db):
    # Kept outside the database being wiped so resets cannot delete their lease.
    return db.client[CONTROL_DATABASE].startup


def sandbox_database_name(generation: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", generation):
        raise ValueError("Invalid sandbox generation")
    return f"{SANDBOX_DATABASE}_{generation}"


def _is_generation_database(name):
    return isinstance(name, str) and bool(re.fullmatch(rf"{SANDBOX_DATABASE}_[0-9a-f]{{32}}", name))


def active_sandbox_database(client, settings):
    """Resolve the ready sandbox for operator commands without ever seeding another database."""
    if settings.mongodb_database != SANDBOX_DATABASE:
        raise RuntimeError("Operator commands are restricted to the Mongo sandbox")
    state = _state(client[SANDBOX_DATABASE]).find_one({"_id": "startup", "status": "ready"})
    if not state or state.get("active_database") != sandbox_database_name(state.get("owner", "")):
        raise RuntimeError("Start the sandbox API and wait for its import to finish first")
    return client[state["active_database"]]


def sandbox_ready(db, generation: str) -> bool:
    """Retire old instances as soon as another process starts rebuilding the sandbox."""
    try:
        return bool(_state(db).find_one({"_id": "startup", "owner": generation, "status": "ready"}))
    except PyMongoError:
        return False


class _ResetLease:
    def __init__(self, db):
        self.collection = _state(db)
        self.owner = uuid4().hex
        self.stop = Event()
        self.lost = Event()

    def __enter__(self):
        now = datetime.now(timezone.utc)
        try:
            self.collection.update_one(
                {
                    "_id": "startup",
                    "$or": [{"status": {"$ne": "resetting"}}, {"lease_until": {"$lte": now}}],
                },
                {
                    "$set": {
                        "owner": self.owner,
                        "status": "resetting",
                        "lease_until": now + timedelta(seconds=LEASE_SECONDS),
                    },
                    "$unset": {"snapshot_id": ""},
                },
                upsert=True,
            )
        except DuplicateKeyError:
            raise RuntimeError(
                "Another process is resetting the Mongo sandbox; retry startup later"
            ) from None
        self.thread = Thread(target=self._renew, daemon=True)
        self.thread.start()
        return self

    def _renew(self):
        while not self.stop.wait(LEASE_SECONDS / 3):
            try:
                result = self.collection.update_one(
                    {"_id": "startup", "owner": self.owner, "status": "resetting"},
                    {"$set": {"lease_until": datetime.now(timezone.utc) + timedelta(seconds=LEASE_SECONDS)}},
                )
                if not result.matched_count:
                    self.lost.set()
                    return
            except PyMongoError:
                self.lost.set()
                return

    def check(self):
        if self.lost.is_set() or not self.collection.find_one(
            {
                "_id": "startup",
                "owner": self.owner,
                "status": "resetting",
                "lease_until": {"$gt": datetime.now(timezone.utc)},
            }
        ):
            raise RuntimeError("Mongo sandbox reset lease was lost; refusing to serve")

    def ready(self, snapshot_id, database_name):
        self.check()
        previous = self.collection.find_one_and_update(
            {
                "_id": "startup",
                "owner": self.owner,
                "status": "resetting",
                "lease_until": {"$gt": datetime.now(timezone.utc)},
            },
            {"$set": {"status": "ready", "snapshot_id": snapshot_id, "active_database": database_name}},
        )
        if previous is None:
            raise RuntimeError("Mongo sandbox reset lease was lost; refusing to serve")
        return previous.get("active_database")

    def __exit__(self, exc_type, exc, traceback):
        self.stop.set()
        self.thread.join(timeout=5)
        if exc_type is not None:
            self.collection.update_one(
                {"_id": "startup", "owner": self.owner}, {"$set": {"status": "failed"}}
            )


def reset_sandbox(db, settings) -> str:
    """Replace served sandbox data with a fresh, verified generation every startup.

    Unique physical databases isolate late requests and expired reset owners.
    Publication is fenced by the lease owner. Only retired generation databases
    can be dropped; production/base database names cannot pass that guard.
    """
    if db.name != SANDBOX_DATABASE or settings.mongodb_database != SANDBOX_DATABASE:
        raise RuntimeError(f"Startup reset is restricted to database {SANDBOX_DATABASE}")
    source = settings.supabase_db_url.get_secret_value()
    if not source:
        raise RuntimeError("SUPABASE_DB_URL is required to rebuild the Mongo sandbox at startup")
    target = None
    published = False
    try:
        with _ResetLease(db) as lease, TemporaryDirectory(prefix="sa-sandbox-") as folder:
            logger.info("Exporting read-only Supabase snapshot for Mongo sandbox startup")
            snapshot = Path(folder) / "snapshot"
            export_from_postgres(
                source,
                snapshot,
                supabase_url=settings.supabase_url,
                storage_key=settings.supabase_service_role_key.get_secret_value(),
            )
            bundle = load_bundle(snapshot)
            lease.check()
            candidate = sandbox_database_name(lease.owner)
            # Never reuse an existing physical database, even on an improbable UUID collision.
            if candidate in db.client.list_database_names():
                raise RuntimeError("Sandbox generation already exists")
            target = candidate
            logger.info("Snapshot validated; importing a fresh disposable Mongo sandbox")
            import_bundle(db.client[target], bundle, apply=True)
            previous = lease.ready(bundle.manifest["snapshot_id"], target)
            published = True
            if _is_generation_database(previous) and previous != target:
                try:
                    db.client.drop_database(previous)
                except PyMongoError:
                    # An inaccessible retired database cannot affect the new generation.
                    logger.warning("Retired sandbox cleanup failed; the new generation remains isolated")
            logger.info("Mongo sandbox import verified and ready")
            return lease.owner
    except Exception as exc:
        if target is not None and not published:
            try:
                db.client.drop_database(target)
            except PyMongoError:
                logger.warning("Incomplete sandbox cleanup failed")
        # PostgreSQL/HTTP driver errors can contain credentials or private values.
        logger.error("Mongo sandbox startup failed (%s); API will not serve", type(exc).__name__)
        raise RuntimeError(
            f"Mongo sandbox startup failed ({type(exc).__name__}); check source access and target connectivity"
        ) from None
