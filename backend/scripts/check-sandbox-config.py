#!/usr/bin/env python3
"""Validate sandbox startup configuration before deployment without printing secrets."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402


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
            "MONGODB_SERVER",
            "APP_SESSION_SECRET",
            "SUPABASE_DB_URL",
            "SUPABASE_URL",
            "SUPABASE_PUBLISHABLE_KEY",
        )
        if any(not values.get(key) for key in required):
            raise ValueError("missing configuration")
        if values.get("CORS_ORIGINS"):
            values["CORS_ORIGINS"] = json.loads(values["CORS_ORIGINS"])
        if values.get("MONGODB_OPTIONS"):
            values["MONGODB_OPTIONS"] = json.loads(values["MONGODB_OPTIONS"])
        settings = Settings(
            _env_file=None,
            # Validate only the deployment file, without merging ambient connection options or credentials.
            _env_prefix="__SA_PREFLIGHT_UNUSED_",
            **{key.lower(): value for key, value in values.items()},
        )
        if not settings.supabase_db_url.get_secret_value() or not settings.supabase_url:
            raise ValueError("missing source")
        if not settings.supabase_publishable_key:
            raise ValueError("missing auth")
    except Exception:
        print(
            "Sandbox configuration rejected: set MONGODB_DATABASE, SUPABASE_DB_URL, "
            "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, MONGODB_SERVER and APP_SESSION_SECRET in the env file; "
            "configure MONGODB_USERNAME and MONGODB_PASSWORD together, with MONGODB_APP_NAME and MONGODB_OPTIONS.",
            file=sys.stderr,
        )
        return 1
    print(f"Startup configuration checked; startup overwrites database {settings.mongodb_database}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
