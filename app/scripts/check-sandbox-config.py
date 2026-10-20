#!/usr/bin/env python3
"""Validate sandbox startup configuration before deployment without printing secrets."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sa_backend.config import Settings  # noqa: E402
from sa_backend.sandbox import SANDBOX_DATABASE  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        # The mounted file, rather than this operator's environment, configures Cloud Run.
        from dotenv import dotenv_values

        values = dotenv_values(args.env_file)
        required = (
            "MONGODB_DATABASE",
            "MONGODB_URI",
            "APP_SESSION_SECRET",
            "SUPABASE_DB_URL",
            "SUPABASE_URL",
            "SUPABASE_PUBLISHABLE_KEY",
        )
        if any(not values.get(key) for key in required):
            raise ValueError("missing configuration")
        if values.get("CORS_ORIGINS"):
            values["CORS_ORIGINS"] = json.loads(values["CORS_ORIGINS"])
        settings = Settings(_env_file=None, **{key.lower(): value for key, value in values.items()})
        if settings.mongodb_database != SANDBOX_DATABASE:
            raise ValueError("unsafe database")
        if not settings.supabase_db_url.get_secret_value() or not settings.supabase_url:
            raise ValueError("missing source")
        if not settings.supabase_publishable_key:
            raise ValueError("missing auth")
    except Exception:
        print(
            f"Sandbox configuration rejected: set MONGODB_DATABASE={SANDBOX_DATABASE}, SUPABASE_DB_URL, "
            "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, MONGODB_URI and APP_SESSION_SECRET in the env file.",
            file=sys.stderr,
        )
        return 1
    print(f"Sandbox startup configuration checked; only {SANDBOX_DATABASE}_<generation> will be reset.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
