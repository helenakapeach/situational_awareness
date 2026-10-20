#!/usr/bin/env python3
"""Export Supabase business data, dry-run/import into a fresh Mongo database, and verify."""

import argparse
import json
import os
import sys
from pathlib import Path

# Keep this a directly executable script without requiring package installation.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import dotenv_values  # noqa: E402
from pymongo import MongoClient  # noqa: E402

from sa_backend.migration import MigrationError, import_bundle, load_bundle, verify_bundle  # noqa: E402
from sa_backend.supabase_dump import export_from_postgres  # noqa: E402


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    sub = cli.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export", help="Read-only Supabase/Postgres export; Auth stays in Supabase")
    export.add_argument("--output", required=True, type=Path, help="New private snapshot directory")
    validate = sub.add_parser(
        "validate", help="Validate an existing snapshot offline, without connecting to a DB"
    )
    validate.add_argument("--input", required=True, type=Path)
    for name in ("import", "verify"):
        command = sub.add_parser(
            name, help="Dry-run/apply import" if name == "import" else "Read-only target comparison"
        )
        command.add_argument("--input", required=True, type=Path)
        command.add_argument(
            "--database", required=True, help="Explicit target database; use a fresh namespace"
        )
        if name == "import":
            command.add_argument("--apply", action="store_true", help="Write to Mongo; omitted by default")
    return cli


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    # Environment wins over an env file; values are never printed.
    config = {**dotenv_values(args.env_file), **os.environ}
    try:
        if args.command == "export":
            url = config.get("SUPABASE_DB_URL")
            if not url:
                raise MigrationError(
                    "Set SUPABASE_DB_URL to a PostgreSQL connection with read/sequence privileges"
                )
            manifest = export_from_postgres(
                url,
                args.output,
                supabase_url=config.get("SUPABASE_URL", ""),
                storage_key=config.get("SUPABASE_SERVICE_ROLE_KEY", ""),
            )
            report = {
                "ok": True,
                "snapshot_id": manifest["snapshot_id"],
                "counts": {name: entry["count"] for name, entry in manifest["tables"].items()},
                "avatar_count": len(manifest["avatars"]),
            }
        else:
            bundle = load_bundle(args.input)
            if args.command == "validate":
                report = {
                    "ok": True,
                    "snapshot_id": bundle.manifest["snapshot_id"],
                    "counts": {name: len(rows) for name, rows in bundle.documents.items()},
                    "avatar_count": len(bundle.avatars),
                }
            else:
                if not config.get("MONGODB_URI"):
                    raise MigrationError("Set MONGODB_URI for target operations")
                if not args.database or any(c in args.database for c in '/\\. "$*<>:|?'):
                    raise MigrationError("Invalid target database name")
                with MongoClient(
                    config["MONGODB_URI"], tz_aware=True, serverSelectionTimeoutMS=10000
                ) as client:
                    db = client[args.database]
                    report = (
                        import_bundle(db, bundle, apply=args.apply)
                        if args.command == "import"
                        else verify_bundle(db, bundle)
                    )
        if args.command in ("import", "verify"):
            report["database"] = args.database
        print(json.dumps(report, sort_keys=True))
        return 0 if report["ok"] else 1
    except MigrationError as exc:
        print(f"Migration stopped: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        # Driver/HTTP errors can include connection strings or request headers.
        print(
            f"Migration stopped ({type(exc).__name__}); check connectivity and source/target permissions.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
