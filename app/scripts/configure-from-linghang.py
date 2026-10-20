#!/usr/bin/env python3
"""Reuse the appointments Mongo cluster credentials without printing their values."""

import argparse
import json
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import dotenv_values

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sa_backend.sandbox import SANDBOX_DATABASE  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.home() / "gitSpot/linghang-appt/backend/.env")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    parser.add_argument("--database", default=SANDBOX_DATABASE, choices=[SANDBOX_DATABASE])
    args = parser.parse_args()
    source = dotenv_values(args.source)
    if not source:
        parser.error("Source env file is missing or empty")
    previous = dotenv_values(args.output) if args.output.exists() else {}
    frontend_path = Path(__file__).resolve().parents[2] / ".env"
    frontend = dotenv_values(frontend_path) if frontend_path.exists() else {}
    uri = source.get("MONGODB_URI")
    if not uri:
        fields = ["MONGODB_USERNAME", "MONGODB_PASSWORD", "MONGODB_CLUSTER_HOST"]
        if any(not source.get(field) for field in fields):
            parser.error("Source requires MONGODB_URI or Mongo username/password/cluster host")
        username = quote_plus(source["MONGODB_USERNAME"])
        password = quote_plus(source["MONGODB_PASSWORD"])
        uri = (
            f"mongodb+srv://{username}:{password}@{source['MONGODB_CLUSTER_HOST']}/"
            "?retryWrites=true&w=majority&appName=LinghangMainApp"
        )
    values = {
        "MONGODB_URI": uri,
        "MONGODB_DATABASE": args.database,
        "APP_SESSION_SECRET": previous.get("APP_SESSION_SECRET") or secrets.token_hex(32),
        "APP_SESSION_TTL_SECONDS": previous.get("APP_SESSION_TTL_SECONDS") or "3600",
        "CORS_ORIGINS": previous.get("CORS_ORIGINS")
        or json.dumps(
            [
                "http://localhost:5173",
                "https://helenakapeach.github.io",
            ]
        ),
        "AUTH0_DOMAIN": (source.get("AUTH0_DOMAIN") or "").removeprefix("https://").rstrip("/"),
        "AUTH0_CLIENT_ID": source.get("AUTH0_CLIENT_ID") or "",
        "SUPABASE_URL": previous.get("SUPABASE_URL") or frontend.get("VITE_SUPABASE_URL") or "",
        "SUPABASE_PUBLISHABLE_KEY": previous.get("SUPABASE_PUBLISHABLE_KEY")
        or frontend.get("VITE_SUPABASE_PUBLISHABLE_KEY")
        or "",
        "SUPABASE_DB_URL": previous.get("SUPABASE_DB_URL") or "",
        "SUPABASE_SERVICE_ROLE_KEY": previous.get("SUPABASE_SERVICE_ROLE_KEY") or "",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Open with restrictive permissions from the first write, including a new file.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(args.output, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write("# Private runtime configuration. Never commit this file.\n")
        for key, value in values.items():
            output.write(f"{key}={json.dumps(str(value))}\n")
    print(f"Configured {args.output}; database={args.database}; credential values omitted.")
    if not values["SUPABASE_DB_URL"]:
        print("Set SUPABASE_DB_URL before startup/deployment; sandbox rebuild requires a source snapshot.")
    if not values["SUPABASE_URL"] or not values["SUPABASE_PUBLISHABLE_KEY"]:
        print("Supabase Auth is not configured yet; inherited Auth0 exchange is available.")


if __name__ == "__main__":
    main()
