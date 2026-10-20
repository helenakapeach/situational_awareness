"""Validated, resumable import of the version 1 Supabase JSONL snapshot."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from pymongo.errors import DuplicateKeyError

from .database import create_indexes

TABLES = (
    "users",
    "cohorts",
    "invite_codes",
    "members",
    "profiles",
    "posts",
    "replies",
    "post_votes",
    "reply_votes",
    "feedback",
)
SEQUENCES = ("post", "reply", "feedback")
MANAGED = (*TABLES, "avatars", "counters")
MARKER_ID = "supabase-to-mongo"
USER_FIELDS = {"id", "email", "user_metadata"}
METADATA_FIELDS = {"name", "full_name", "avatar_url"}
DATETIME_FIELDS = {
    "created_at",
    "updated_at",
    "joined_at",
    "expires_at",
    "redeemed_at",
    "used_at",
}
UUID_WEBP = re.compile(r"^[0-9a-fA-F-]{36}\.webp$")
MAX_AVATAR_BYTES = 1024 * 1024


class MigrationError(ValueError):
    """The snapshot is malformed, unsafe, or incompatible with the target."""


@dataclass(frozen=True)
class MigrationBundle:
    manifest: dict[str, Any]
    documents: dict[str, list[dict[str, Any]]]
    avatars: dict[str, bytes]
    files_verified: bool = False


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_datetime(value: Any, context: str) -> datetime:
    if not isinstance(value, str):
        raise MigrationError(f"{context}: expected ISO datetime")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MigrationError(f"{context}: invalid ISO datetime") from exc
    if parsed.tzinfo is None:
        raise MigrationError(f"{context}: datetime must include timezone")
    return parsed.astimezone(timezone.utc).replace(microsecond=(parsed.microsecond // 1000) * 1000)


def _convert_dates(doc: dict[str, Any], context: str) -> dict[str, Any]:
    result = dict(doc)
    for key in DATETIME_FIELDS:
        if key in result and result[key] is not None:
            result[key] = _parse_datetime(result[key], f"{context}.{key}")
    return result


def _safe_relative(base: Path, value: Any, context: str) -> Path:
    if not isinstance(value, str) or not value or "\\" in value:
        raise MigrationError(f"{context}: unsafe path")
    rel = Path(value)
    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
        raise MigrationError(f"{context}: unsafe path")
    root = base.resolve()
    target = (base / rel).resolve()
    if target != root and root not in target.parents:
        raise MigrationError(f"{context}: unsafe path")
    return target


def load_bundle(path: str | Path) -> MigrationBundle:
    """Read and validate every manifest-declared file before returning a bundle."""
    root = Path(path)
    if root.is_file():
        root = root.parent
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError("manifest is missing or invalid JSON") from exc
    _validate_manifest(manifest)
    documents: dict[str, list[dict[str, Any]]] = {}
    for table in TABLES:
        entry = manifest["tables"][table]
        target = _safe_relative(root, entry["file"], f"tables.{table}.file")
        try:
            raw = target.read_bytes()
        except OSError as exc:
            raise MigrationError(f"tables.{table}: file unavailable") from exc
        if _sha256(raw) != entry["sha256"]:
            raise MigrationError(f"tables.{table}: sha256 mismatch")
        lines = raw.splitlines()
        if len(lines) != entry["count"]:
            raise MigrationError(f"tables.{table}: count mismatch")
        docs = []
        for number, line in enumerate(lines, start=1):
            try:
                row = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise MigrationError(f"tables.{table}:{number}: invalid JSON") from exc
            if not isinstance(row, dict):
                raise MigrationError(f"tables.{table}:{number}: expected object")
            docs.append(_convert_dates(row, f"{table}[{number}]"))
        documents[table] = docs
    avatars: dict[str, bytes] = {}
    for entry in manifest["avatars"]:
        avatar_id = entry["id"]
        target = _safe_relative(root, entry["file"], f"avatars.{avatar_id}.file")
        try:
            blob = target.read_bytes()
        except OSError as exc:
            raise MigrationError(f"avatars.{avatar_id}: file unavailable") from exc
        if len(blob) != entry["size"] or _sha256(blob) != entry["sha256"]:
            raise MigrationError(f"avatars.{avatar_id}: size or sha256 mismatch")
        avatars[avatar_id] = blob
    bundle = MigrationBundle(manifest, documents, avatars, files_verified=True)
    validate_bundle(bundle)
    return bundle


def _validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise MigrationError("unsupported manifest version")
    try:
        UUID(str(manifest["snapshot_id"]))
        _parse_datetime(manifest["exported_at"], "exported_at")
    except (KeyError, ValueError) as exc:
        raise MigrationError("manifest snapshot_id/exported_at invalid") from exc
    tables = manifest.get("tables")
    if not isinstance(tables, dict) or set(tables) != set(TABLES):
        raise MigrationError("manifest must declare exactly the required tables")
    for table, entry in tables.items():
        if not isinstance(entry, dict) or entry.get("file") != f"{table}.jsonl":
            raise MigrationError(f"tables.{table}: invalid file declaration")
        if type(entry.get("count")) is not int or entry["count"] < 0:
            raise MigrationError(f"tables.{table}: invalid count")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise MigrationError(f"tables.{table}: invalid sha256")
    seqs = manifest.get("sequences")
    if (
        not isinstance(seqs, dict)
        or set(seqs) != set(SEQUENCES)
        or any(type(seqs[k]) is not int or seqs[k] < 0 for k in SEQUENCES)
    ):
        raise MigrationError("invalid sequence highwater marks")
    avatars = manifest.get("avatars")
    if not isinstance(avatars, list):
        raise MigrationError("avatars must be an array")
    seen = set()
    for avatar in avatars:
        if not isinstance(avatar, dict):
            raise MigrationError("invalid avatar entry")
        avatar_id = avatar.get("id")
        if not isinstance(avatar_id, str) or not UUID_WEBP.fullmatch(avatar_id) or avatar_id in seen:
            raise MigrationError("invalid or duplicate avatar id")
        try:
            UUID(avatar_id[:-5])
        except ValueError as exc:
            raise MigrationError("invalid avatar UUID") from exc
        seen.add(avatar_id)
        if (
            avatar.get("file") != f"avatars/{avatar_id}"
            or type(avatar.get("size")) is not int
            or not 0 < avatar["size"] <= MAX_AVATAR_BYTES
        ):
            raise MigrationError(f"avatars.{avatar_id}: invalid file or size")
        if not isinstance(avatar.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", avatar["sha256"]):
            raise MigrationError(f"avatars.{avatar_id}: invalid sha256")
        _parse_datetime(avatar.get("created_at"), f"avatars.{avatar_id}.created_at")


def _unique(docs: list[dict[str, Any]], key: str, table: str) -> set[Any]:
    values = set()
    for row in docs:
        value = row.get(key)
        if value is None or value in values:
            raise MigrationError(f"{table}: missing or duplicate {key}")
        values.add(value)
    return values


def _positive_int(value: Any, context: str) -> None:
    if type(value) is not int or value <= 0:
        raise MigrationError(f"{context}: expected positive integer")


def _safe_document_keys(value: Any, context: str) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str) or key == "_id" or key.startswith("$") or "." in key:
                raise MigrationError(f"{context}: unsupported document key")
            _safe_document_keys(nested, context)
    elif isinstance(value, list):
        for nested in value:
            _safe_document_keys(nested, context)


def _validate_boolean_fields(row: dict[str, Any], fields: tuple[str, ...], context: str) -> None:
    for field in fields:
        if field in row and type(row[field]) is not bool:
            raise MigrationError(f"{context}.{field}: expected boolean")


def validate_bundle(bundle: MigrationBundle) -> None:
    """Validate IDs, references, identities, timestamps, and avatar links."""
    _validate_manifest(bundle.manifest)
    if set(bundle.documents) != set(TABLES):
        raise MigrationError("bundle must contain exactly the required tables")
    for table in TABLES:
        if len(bundle.documents[table]) != bundle.manifest["tables"][table]["count"]:
            raise MigrationError(f"tables.{table}: count mismatch")
        for number, row in enumerate(bundle.documents[table], start=1):
            if not isinstance(row, dict):
                raise MigrationError(f"tables.{table}: expected object")
            _safe_document_keys(row, f"{table}[{number}]")
    users = bundle.documents["users"]
    user_ids = _unique(users, "id", "users")
    for row in users:
        if set(row) - USER_FIELDS:
            raise MigrationError("users: unsupported field (identity secrets are not importable)")
        metadata = row.get("user_metadata") or {}
        if not isinstance(metadata, dict) or set(metadata) - METADATA_FIELDS:
            raise MigrationError("users.user_metadata: unsupported field")
        try:
            UUID(row["id"])
        except (ValueError, TypeError) as exc:
            raise MigrationError("users.id must be a UUID string") from exc
    cohorts = bundle.documents["cohorts"]
    cohort_ids = _unique(cohorts, "id", "cohorts")
    for cohort_id in cohort_ids:
        _positive_int(cohort_id, "cohorts.id")
    _unique(cohorts, "name", "cohorts")
    for cohort in cohorts:
        _validate_boolean_fields(cohort, ("is_active",), "cohorts")
    invites = bundle.documents["invite_codes"]
    invite_codes = _unique(invites, "code", "invite_codes")
    for invite in invites:
        _validate_boolean_fields(invite, ("is_active",), "invite_codes")
    if any(row.get("created_by") is not None and row["created_by"] not in user_ids for row in invites):
        raise MigrationError("invite_codes reference missing user")
    members = bundle.documents["members"]
    member_ids = _unique(members, "user_id", "members")
    for member in members:
        _validate_boolean_fields(member, ("is_admin", "is_disabled"), "members")
    if not member_ids <= user_ids:
        raise MigrationError("members reference missing user")
    if any(m.get("invite_code") not in (None, "") and m["invite_code"] not in invite_codes for m in members):
        raise MigrationError("members reference missing invite code")
    profiles = bundle.documents["profiles"]
    profile_users = _unique(profiles, "user_id", "profiles")
    public_ids = _unique(profiles, "public_id", "profiles")
    for public_id in public_ids:
        try:
            UUID(public_id)
        except (ValueError, TypeError) as exc:
            raise MigrationError("profiles.public_id must be a UUID string") from exc
    if not profile_users <= user_ids:
        raise MigrationError("profiles reference missing user")
    for profile in profiles:
        _validate_boolean_fields(
            profile,
            ("role_verified", "linkedin_public", "email_public", "wechat_public"),
            "profiles",
        )
        if profile.get("cohort_id") is not None and profile["cohort_id"] not in cohort_ids:
            raise MigrationError("profiles reference missing cohort")
        avatar = profile.get("avatar_url")
        if isinstance(avatar, str) and not avatar.startswith("https://") and avatar.endswith(".webp"):
            if not UUID_WEBP.fullmatch(avatar):
                raise MigrationError("invalid custom avatar id")
            try:
                UUID(avatar[:-5])
            except ValueError as exc:
                raise MigrationError("invalid custom avatar UUID") from exc
            if avatar not in bundle.avatars:
                raise MigrationError("profile references missing custom avatar")
    posts = bundle.documents["posts"]
    for post in posts:
        if "is_anonymous" not in post:
            raise MigrationError("posts.is_anonymous is required")
        _validate_boolean_fields(post, ("is_anonymous", "author_role_verified"), "posts")
    post_ids = _unique(posts, "id", "posts")
    for post_id in post_ids:
        _positive_int(post_id, "posts.id")
    if any(p.get("author_id") not in user_ids for p in posts):
        raise MigrationError("posts reference missing user")
    replies = bundle.documents["replies"]
    for reply in replies:
        if "is_anonymous" not in reply:
            raise MigrationError("replies.is_anonymous is required")
        _validate_boolean_fields(reply, ("is_anonymous", "author_role_verified"), "replies")
    reply_ids = _unique(replies, "id", "replies")
    for reply_id in reply_ids:
        _positive_int(reply_id, "replies.id")
    if any(r.get("post_id") not in post_ids or r.get("author_id") not in user_ids for r in replies):
        raise MigrationError("replies reference missing post or user")
    reply_by_id = {row["id"]: row for row in replies}
    for reply in replies:
        _positive_int(reply.get("post_id"), "replies.post_id")
        if reply.get("parent_reply_id") is not None:
            _positive_int(reply["parent_reply_id"], "replies.parent_reply_id")
        parent = reply.get("parent_reply_id")
        if parent is not None and (
            parent not in reply_ids or reply_by_id[parent].get("post_id") != reply["post_id"]
        ):
            raise MigrationError("replies reference missing or cross-post parent")
    for table, content_key, ids in (
        ("post_votes", "post_id", post_ids),
        ("reply_votes", "reply_id", reply_ids),
    ):
        seen = set()
        for row in bundle.documents[table]:
            key = (row.get(content_key), row.get("user_id"))
            _positive_int(key[0], f"{table}.{content_key}")
            if key in seen or key[0] not in ids or key[1] not in user_ids:
                raise MigrationError(f"{table}: duplicate or invalid reference")
            seen.add(key)
    for row in bundle.documents["feedback"]:
        if "author_id" in row and "user_id" in row and row["author_id"] != row["user_id"]:
            raise MigrationError("feedback author_id and user_id disagree")
        if row.get("author_id", row.get("user_id")) not in user_ids:
            raise MigrationError("feedback reference missing user")
    feedback_ids = _unique(bundle.documents["feedback"], "id", "feedback")
    for feedback_id in feedback_ids:
        _positive_int(feedback_id, "feedback.id")
    maxima = {
        "post": max(post_ids, default=0),
        "reply": max(reply_ids, default=0),
        "feedback": max((row.get("id", 0) for row in bundle.documents["feedback"]), default=0),
    }
    for key, maximum in maxima.items():
        if bundle.manifest["sequences"][key] < maximum:
            raise MigrationError(f"sequence {key} is below existing maximum id")
    if {entry["id"] for entry in bundle.manifest["avatars"]} != set(bundle.avatars):
        raise MigrationError("avatar file set does not match manifest")
    avatar_entries = {entry["id"]: entry for entry in bundle.manifest["avatars"]}
    for avatar_id, blob in bundle.avatars.items():
        entry = avatar_entries[avatar_id]
        if len(blob) != entry["size"] or _sha256(blob) != entry["sha256"]:
            raise MigrationError(f"avatars.{avatar_id}: size or sha256 mismatch")


def _natural_key(table: str) -> str | tuple[str, str]:
    if table == "post_votes":
        return ("post_id", "user_id")
    if table == "reply_votes":
        return ("reply_id", "user_id")
    return {"members": "user_id", "profiles": "user_id", "invite_codes": "code"}.get(table, "id")


def _key_value(doc: dict[str, Any], key: str | tuple[str, str]) -> Any:
    return tuple(doc.get(field) for field in key) if isinstance(key, tuple) else doc.get(key)


def _key_filter(doc: dict[str, Any], key: str | tuple[str, str]) -> dict[str, Any]:
    return {field: doc[field] for field in key} if isinstance(key, tuple) else {key: doc[key]}


def _normalized_docs(bundle: MigrationBundle) -> dict[str, list[dict[str, Any]]]:
    result = {name: [dict(doc) for doc in bundle.documents[name]] for name in TABLES}
    user_emails = {user["id"]: user.get("email") for user in result["users"]}
    for row in result["feedback"]:
        if "author_id" in row:
            row["user_id"] = row.pop("author_id")
    for row in result["members"]:
        row["email"] = user_emails[row["user_id"]]
    for row in result["profiles"]:
        row.pop("avatar_pending", None)
    return result


def _scrub_db_doc(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in {"_id", "revision"}}


def verify_bundle(db: Any, bundle: MigrationBundle | str | Path) -> dict[str, Any]:
    """Read-only content verification; reports counts and generic error labels only."""
    if not isinstance(bundle, MigrationBundle):
        bundle = load_bundle(bundle)
    if not bundle.files_verified:
        raise MigrationError("bundle must be loaded from verified snapshot files")
    validate_bundle(bundle)
    expected = _normalized_docs(bundle)
    errors: list[str] = []
    counts: dict[str, dict[str, int]] = {}
    for table in TABLES:
        key = _natural_key(table)
        got = list(db[table].find({}))
        counts[table] = {"expected": len(expected[table]), "actual": len(got)}
        actual_by_key = {_key_value(doc, key): _scrub_db_doc(doc) for doc in got}
        expected_by_key = {_key_value(doc, key): doc for doc in expected[table]}
        if len(actual_by_key) != len(got) or set(actual_by_key) != set(expected_by_key):
            errors.append(f"{table}: keys differ")
            continue
        for natural_id, source in expected_by_key.items():
            actual = actual_by_key[natural_id]
            if actual != source:
                errors.append(f"{table}: content differs")
                break
    for entry in bundle.manifest["avatars"]:
        actual = db.avatars.find_one({"id": entry["id"]})
        if not actual or _sha256(actual.get("data", b"")) != entry["sha256"]:
            errors.append("avatars: content differs")
    if db.avatars.count_documents({}) != len(bundle.avatars):
        errors.append("avatars: keys differ")
    for name, highwater in bundle.manifest["sequences"].items():
        counter = db.counters.find_one({"_id": name})
        if not counter or counter.get("value", -1) < highwater:
            errors.append(f"counters.{name}: below highwater")
    return {
        "ok": not errors,
        "snapshot_id": bundle.manifest["snapshot_id"],
        "counts": counts,
        "errors": errors,
    }


def _target_status(db: Any, snapshot_id: str) -> dict[str, Any] | None:
    marker = db.migration_state.find_one({"_id": MARKER_ID})
    if marker:
        if marker.get("snapshot_id") != snapshot_id:
            raise MigrationError("target is marked for a different snapshot")
        if marker.get("status") not in {"in_progress", "complete"}:
            raise MigrationError("target has an unknown migration state")
        return marker
    for collection in MANAGED:
        if db[collection].count_documents({}):
            raise MigrationError("target has existing managed data and no matching migration marker")
    return None


def import_bundle(db: Any, bundle: MigrationBundle | str | Path, *, apply: bool = False) -> dict[str, Any]:
    """Validate and optionally import a snapshot. Dry-run is strictly read-only."""
    if not isinstance(bundle, MigrationBundle):
        bundle = load_bundle(bundle)
    if not bundle.files_verified:
        raise MigrationError("bundle must be loaded from verified snapshot files")
    validate_bundle(bundle)
    snapshot_id = str(bundle.manifest["snapshot_id"])
    marker = _target_status(db, snapshot_id)
    if not apply:
        if marker and marker.get("status") == "complete":
            verification = verify_bundle(db, bundle)
            if not verification["ok"]:
                raise MigrationError("completed snapshot differs from target; use a fresh namespace")
            return {
                "ok": True,
                "applied": False,
                "already_complete": True,
                "snapshot_id": snapshot_id,
                "counts": verification["counts"],
                "avatar_count": len(bundle.avatars),
            }
        return {
            "ok": True,
            "applied": False,
            "snapshot_id": snapshot_id,
            "resumable": bool(marker),
            "counts": {table: len(bundle.documents[table]) for table in TABLES},
            "avatar_count": len(bundle.avatars),
        }
    if marker and marker.get("status") == "complete":
        verification = verify_bundle(db, bundle)
        if not verification["ok"]:
            raise MigrationError("completed snapshot differs from target; use a fresh namespace")
        return {
            "ok": True,
            "applied": False,
            "already_complete": True,
            "snapshot_id": snapshot_id,
            "counts": verification["counts"],
        }

    # A marker makes retries safe after any subsequent failure. Never replace a
    # different source snapshot, and never drop pre-existing application data.
    try:
        db.migration_state.update_one(
            {"_id": MARKER_ID, "snapshot_id": snapshot_id},
            {"$set": {"status": "in_progress", "started_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
    except DuplicateKeyError as exc:
        raise MigrationError("target is claimed by a different snapshot") from exc
    create_indexes(db)
    docs = _normalized_docs(bundle)
    for table in TABLES:
        key = _natural_key(table)
        for row in docs[table]:
            db[table].replace_one(_key_filter(row, key), row, upsert=True)
    for entry in bundle.manifest["avatars"]:
        db.avatars.replace_one(
            {"id": entry["id"]},
            {
                "id": entry["id"],
                "data": bundle.avatars[entry["id"]],
                "content_type": "image/webp",
                "created_at": _parse_datetime(entry["created_at"], "avatar.created_at"),
            },
            upsert=True,
        )
    for counter, highwater in bundle.manifest["sequences"].items():
        db.counters.update_one({"_id": counter}, {"$max": {"value": highwater}}, upsert=True)
    verification = verify_bundle(db, bundle)
    if not verification["ok"]:
        raise MigrationError("post-import verification failed: " + ", ".join(verification["errors"]))
    db.migration_state.update_one(
        {"_id": MARKER_ID, "snapshot_id": snapshot_id},
        {"$set": {"status": "complete", "completed_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "applied": True, "snapshot_id": snapshot_id, "counts": verification["counts"]}
