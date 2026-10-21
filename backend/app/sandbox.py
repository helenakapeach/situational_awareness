"""Overwrite the configured Mongo test database from Supabase on every startup."""

import logging
from pathlib import Path
from tempfile import TemporaryDirectory

from pymongo.errors import OperationFailure

from .migration import import_bundle, load_bundle
from .supabase_dump import export_from_postgres

logger = logging.getLogger(__name__)


def reset_sandbox(db, settings) -> dict:
    """Export and validate the source, then wipe and import the same configured database."""
    source = settings.supabase_db_url.get_secret_value()
    if not source:
        raise RuntimeError("SUPABASE_DB_URL is required to rebuild Mongo at startup")
    stage = "export_snapshot"
    try:
        with TemporaryDirectory(prefix="sa-sandbox-") as folder:
            snapshot = Path(folder) / "snapshot"
            logger.info("Exporting read-only Supabase snapshot for Mongo startup")
            export_from_postgres(
                source,
                snapshot,
                supabase_url=settings.supabase_url,
                storage_key=settings.supabase_service_role_key.get_secret_value(),
            )
            stage = "validate_snapshot"
            bundle = load_bundle(snapshot)
            stage = "reset_database"
            db.client.drop_database(db.name)
            stage = "import_snapshot"
            result = import_bundle(db, bundle, apply=True)
            logger.info("Mongo database %s overwritten and import verified", db.name)
            return result
    except Exception as exc:
        # Driver messages can contain credentials or private data; expose only the stage and error code.
        detail = f"{type(exc).__name__}, stage={stage}"
        if isinstance(exc, OperationFailure):
            detail += f", mongo_code={exc.code}"
        logger.error("Mongo startup import failed (%s); API will not serve", detail)
        raise RuntimeError(
            f"Mongo startup import failed ({detail}); check source access and target connectivity"
        ) from None
