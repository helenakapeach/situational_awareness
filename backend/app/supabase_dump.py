"""Read-only PostgreSQL export into the Mongo migration bundle format.

Auth stays in Supabase. Only referenced users' identity fields are exported.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx

from .migration import MigrationError

TABLE_KEYS = {
    "cohorts": ("id",),
    "invite_codes": ("code",),
    "members": ("user_id",),
    "profiles": ("user_id",),
    "posts": ("id",),
    "replies": ("id",),
    "post_votes": ("post_id", "user_id"),
    "reply_votes": ("reply_id", "user_id"),
    "feedback": ("id",),
}
AVATAR_NAME = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$", re.I)
REFERENCED_USERS = """
SELECT user_id FROM public.members
UNION SELECT user_id FROM public.profiles
UNION SELECT author_id FROM public.posts
UNION SELECT author_id FROM public.replies
UNION SELECT user_id FROM public.post_votes
UNION SELECT user_id FROM public.reply_votes
UNION SELECT author_id FROM public.feedback
UNION SELECT created_by FROM public.invite_codes WHERE created_by IS NOT NULL
"""


def json_value(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise MigrationError("Source timestamp has no timezone")
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    raise TypeError(f"Unsupported source value type: {type(value).__name__}")


def private_write(path: Path, data: bytes):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)


def write_rows(path: Path, rows, avatar_names: set[str]) -> dict:
    digest = hashlib.sha256()
    count = 0
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        for original in rows:
            row = dict(original)
            if path.stem == "users":
                metadata = row.get("user_metadata") or {}
                row["user_metadata"] = {
                    key: metadata[key]
                    for key in ("full_name", "name", "avatar_url")
                    if isinstance(metadata.get(key), str)
                }
            if path.stem == "profiles":
                avatar = row.get("avatar_url")
                if isinstance(avatar, str) and AVATAR_NAME.fullmatch(avatar):
                    avatar_names.add(avatar)
            data = (
                json.dumps(row, default=json_value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                + "\n"
            ).encode()
            output.write(data)
            digest.update(data)
            count += 1
    return {"file": path.name, "count": count, "sha256": digest.hexdigest()}


def export_bundle(connection, output: Path, *, supabase_url="", storage_key="", http_client=None) -> dict:
    """Export one repeatable-read SQL snapshot. Never write source SQL or MongoDB.

    Storage is downloaded separately; freeze source business writes for a final cutover.
    The destination is published atomically and must not already exist.
    """
    output = Path(output).absolute()
    if output.exists():
        raise MigrationError("Output directory already exists; choose a new snapshot directory")
    if supabase_url:
        try:
            parsed = urlsplit(supabase_url)
            valid = (
                parsed.scheme == "https"
                and bool(parsed.hostname)
                and parsed.username is None
                and parsed.password is None
                and parsed.path in ("", "/")
                and not parsed.query
                and not parsed.fragment
            )
        except ValueError:
            valid = False
        if not valid:
            raise MigrationError("SUPABASE_URL must be an HTTPS origin without credentials")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.parent / f".{output.name}.partial-{uuid4().hex}"
    temporary.mkdir(mode=0o700)
    created = datetime.now(timezone.utc)
    manifest = {
        "version": 1,
        "snapshot_id": str(uuid4()),
        "exported_at": json_value(created),
        "tables": {},
        "sequences": {},
        "avatars": [],
    }
    avatar_names: set[str] = set()
    try:
        with connection.transaction():
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            queries = {
                "users": (
                    "SELECT id, email, raw_user_meta_data AS user_metadata FROM auth.users "
                    f"WHERE id IN ({REFERENCED_USERS}) ORDER BY id"
                )
            }
            queries.update(
                {
                    name: f"SELECT * FROM public.{name} ORDER BY {', '.join(keys)}"
                    for name, keys in TABLE_KEYS.items()
                }
            )
            for name, query in queries.items():
                with connection.cursor(name=f"export_{name}") as cursor:
                    cursor.itersize = 1000
                    cursor.execute(query)
                    manifest["tables"][name] = write_rows(temporary / f"{name}.jsonl", cursor, avatar_names)
            for table, counter in (("posts", "post"), ("replies", "reply"), ("feedback", "feedback")):
                row = connection.execute(
                    "SELECT pg_get_serial_sequence(%s, 'id') AS name", (f"public.{table}",)
                ).fetchone()
                sequence = row["name"]
                if not sequence or not re.fullmatch(r"public\.[a-z_][a-z0-9_]*", sequence):
                    raise MigrationError(f"Unable to identify expected sequence for {table}")
                last = connection.execute(f"SELECT last_value, is_called FROM {sequence}").fetchone()
                maximum = connection.execute(
                    f"SELECT coalesce(max(id), 0) AS maximum FROM public.{table}"
                ).fetchone()["maximum"]
                used = last["last_value"] if last["is_called"] else last["last_value"] - 1
                manifest["sequences"][counter] = max(used, maximum)
            object_dates = {}
            if avatar_names:
                for row in connection.execute(
                    "SELECT name, created_at FROM storage.objects WHERE bucket_id = 'avatars' AND name = ANY(%s)",
                    (sorted(avatar_names),),
                ):
                    object_dates[row["name"]] = row["created_at"]
                if set(object_dates) != avatar_names:
                    raise MigrationError(
                        "One or more referenced avatar objects are missing from Storage metadata"
                    )

        if avatar_names:
            if not supabase_url:
                raise MigrationError("SUPABASE_URL is required to export referenced avatar files")
            (temporary / "avatars").mkdir(mode=0o700)
            owned_client = http_client is None
            client = http_client or httpx.Client(timeout=30, follow_redirects=False)
            try:
                for name in sorted(avatar_names):
                    headers = (
                        {"apikey": storage_key, "Authorization": f"Bearer {storage_key}"}
                        if storage_key
                        else {}
                    )
                    route = "avatars" if storage_key else "public/avatars"
                    url = f"{supabase_url.rstrip('/')}/storage/v1/object/{route}/{name}"
                    # Stream with a hard bound matching the API's avatar limit.
                    content = bytearray()
                    with client.stream("GET", url, headers=headers) as response:
                        response.raise_for_status()
                        for chunk in response.iter_bytes():
                            content.extend(chunk)
                            if len(content) > 1024 * 1024:
                                raise MigrationError("avatars: source file exceeds the supported 1MB limit")
                    data = bytes(content)
                    private_write(temporary / "avatars" / name, data)
                    manifest["avatars"].append(
                        {
                            "id": name,
                            "file": f"avatars/{name}",
                            "sha256": hashlib.sha256(data).hexdigest(),
                            "size": len(data),
                            "created_at": json_value(object_dates[name]),
                        }
                    )
            finally:
                if owned_client:
                    client.close()
        private_write(temporary / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
        # Validate hashes, identities and relations before publishing an importable dump.
        from .migration import load_bundle

        load_bundle(temporary)
        temporary.rename(output)
        return manifest
    except BaseException:
        shutil.rmtree(temporary)
        raise


def export_from_postgres(database_url: str, output: Path, **kwargs) -> dict:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise MigrationError(
            "Install the migration extra: uv sync --project backend --extra migration"
        ) from exc
    with psycopg.connect(database_url, row_factory=dict_row, connect_timeout=15) as connection:
        return export_bundle(connection, output, **kwargs)
