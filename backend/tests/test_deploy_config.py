"""Deployment preflight rejects unsafe/incomplete files before any cloud changes."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check-sandbox-config.py"


@pytest.mark.parametrize(
    "change",
    [
        {},
        {"MONGODB_DATABASE": "linghang_main_app"},
        {"SUPABASE_DB_URL": ""},
        {"MONGODB_SERVER": ""},
        {"MONGODB_PASSWORD": ""},
        {"MONGODB_OPTIONS": "not-json"},
    ],
)
def test_preflight_validates_the_file_without_printing_credentials(tmp_path, change):
    values = {
        "MONGODB_SERVER": "mongodb://localhost:27017",
        "MONGODB_USERNAME": "readonly",
        "MONGODB_PASSWORD": "do-not-print",
        "MONGODB_APP_NAME": "linghang-main-app",
        "MONGODB_OPTIONS": '{"replicaSet":"rs0","directConnection":true}',
        "MONGODB_DATABASE": "linghang_main_app_sandbox",
        "APP_SESSION_SECRET": "test-only-independent-secret-1234567890",
        "SUPABASE_DB_URL": "postgresql://readonly:never-print-this@localhost:5432/postgres",
        "SUPABASE_URL": "https://identity.example.test",
        "SUPABASE_PUBLISHABLE_KEY": "test-publishable-key",
        "CORS_ORIGINS": '["http://localhost:5173"]',
        **change,
    }
    env_file = tmp_path / ".env"
    env_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--env-file", str(env_file)],
        capture_output=True,
        text=True,
        env={**os.environ, "MONGODB_DATABASE": "ambient-production-db", "SUPABASE_DB_URL": "ambient-secret"},
        check=False,
    )
    assert result.returncode == (1 if change else 0)
    output = result.stdout + result.stderr
    assert "do-not-print" not in output
    assert "never-print-this" not in output
    assert "ambient-secret" not in output
