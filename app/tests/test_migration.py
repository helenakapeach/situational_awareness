import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from sa_backend.migration import MigrationError, import_bundle, load_bundle, validate_bundle, verify_bundle
from sa_backend.services import bootstrap_indexes, create_indexes

USER1 = "00000000-0000-4000-8000-000000000001"
USER2 = "00000000-0000-4000-8000-000000000002"
PUBLIC1 = "00000000-0000-4000-8000-000000000003"


def make_bundle(root: Path):
    avatar_id = str(uuid4()) + ".webp"
    rows = {
        "users": [
            {
                "id": USER1,
                "email": "u1@example.test",
                "user_metadata": {"name": "Ada", "avatar_url": "https://example.test/a"},
            },
            {"id": USER2, "email": "u2@example.test", "user_metadata": {}},
        ],
        "cohorts": [{"id": 8, "name": "Cohort", "is_active": True}],
        "invite_codes": [{"code": "JOIN", "used_count": 1, "is_active": True}],
        "members": [
            {
                "user_id": USER1,
                "invite_code": "JOIN",
                "is_admin": False,
                "is_disabled": False,
                "joined_at": "2025-01-01T00:00:00.123Z",
            }
        ],
        "profiles": [
            {
                "user_id": USER1,
                "public_id": PUBLIC1,
                "display_name": "Ada",
                "cohort_id": 8,
                "avatar_url": avatar_id,
                "avatar_pending": "discard.webp",
                "role_verified": True,
                "updated_at": "2025-01-02T00:00:00Z",
            }
        ],
        "posts": [
            {
                "id": 12,
                "author_id": USER1,
                "title": "Hello",
                "body": "Text",
                "is_anonymous": False,
                "created_at": "2025-01-03T00:00:00.456Z",
            }
        ],
        "replies": [
            {
                "id": 16,
                "post_id": 12,
                "author_id": USER1,
                "parent_reply_id": None,
                "body": "Reply",
                "is_anonymous": False,
                "created_at": "2025-01-04T00:00:00Z",
            }
        ],
        "post_votes": [
            {"post_id": 12, "user_id": USER1, "created_at": "2025-01-05T00:00:00Z"},
            {"post_id": 12, "user_id": USER2, "created_at": "2025-01-05T00:01:00Z"},
        ],
        "reply_votes": [{"reply_id": 16, "user_id": USER1, "created_at": "2025-01-05T00:00:00Z"}],
        "feedback": [
            {"id": 21, "author_id": USER1, "body": "Feedback", "created_at": "2025-01-06T00:00:00Z"}
        ],
    }
    (root / "avatars").mkdir(parents=True)
    blob = b"webp bytes"
    (root / "avatars" / avatar_id).write_bytes(blob)
    manifest = {
        "version": 1,
        "snapshot_id": str(uuid4()),
        "exported_at": "2025-02-01T00:00:00Z",
        "tables": {},
        "sequences": {"post": 15, "reply": 20, "feedback": 25},
        "avatars": [
            {
                "id": avatar_id,
                "file": f"avatars/{avatar_id}",
                "sha256": hashlib.sha256(blob).hexdigest(),
                "size": len(blob),
                "created_at": "2025-01-02T00:00:00Z",
            }
        ],
    }
    for table, table_rows in rows.items():
        raw = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in table_rows).encode()
        (root / f"{table}.jsonl").write_bytes(raw)
        manifest["tables"][table] = {
            "file": f"{table}.jsonl",
            "count": len(table_rows),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root, manifest, rows, avatar_id, blob


def test_load_bundle_checks_hashes_and_converts_dates(tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    converted = bundle.documents["posts"][0]["created_at"]
    assert converted == datetime(2025, 1, 3, 0, 0, 0, 456000, tzinfo=timezone.utc)
    (path / "posts.jsonl").write_text("{}\n")
    with pytest.raises(MigrationError, match="sha256 mismatch"):
        load_bundle(path)


def test_validation_rejects_traversal_or_orphaned_references(tmp_path):
    path, manifest, rows, _, _ = make_bundle(tmp_path)
    manifest["tables"]["posts"]["file"] = "../posts.jsonl"
    (path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(MigrationError, match="invalid file declaration"):
        load_bundle(path)

    # A directly constructed bundle must also be validated before any import.
    path2, _, _, _, _ = make_bundle(tmp_path / "valid")
    bundle = load_bundle(path2)
    rows2 = {key: [dict(item) for item in values] for key, values in bundle.documents.items()}
    rows2["replies"][0]["post_id"] = 99
    from sa_backend.migration import MigrationBundle

    with pytest.raises(MigrationError, match="missing post"):
        validate_bundle(MigrationBundle(bundle.manifest, rows2, bundle.avatars))


def test_validation_rejects_auth_secrets_and_bad_sequence(tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    from sa_backend.migration import MigrationBundle

    docs = {key: [dict(row) for row in value] for key, value in bundle.documents.items()}
    docs["users"][0]["encrypted_password"] = "must never import"
    with pytest.raises(MigrationError, match="identity secrets"):
        validate_bundle(MigrationBundle(bundle.manifest, docs, bundle.avatars))
    docs["users"][0].pop("encrypted_password")
    manifest = dict(bundle.manifest, sequences={"post": 1, "reply": 20, "feedback": 25})
    with pytest.raises(MigrationError, match="below existing maximum"):
        validate_bundle(MigrationBundle(manifest, docs, bundle.avatars))


def clear_db(db):
    for name in (
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
        "avatars",
        "counters",
        "migration_state",
    ):
        db[name].delete_many({})


def test_dry_run_is_read_only_and_apply_is_resumable(db, tmp_path):
    path, _, _, avatar_id, blob = make_bundle(tmp_path)
    bundle = load_bundle(path)
    clear_db(db)
    # Re-create only indexes, never seeds, and capture state around dry-run.
    create_indexes(db)
    before = {
        name: db[name].count_documents({}) for name in ("users", "cohorts", "counters", "migration_state")
    }
    result = import_bundle(db, bundle)
    assert result["ok"] and not result["applied"]
    assert {name: db[name].count_documents({}) for name in before} == before

    # Simulate a previous import attempt that committed its marker but stopped
    # before source rows. Resume is then permitted to preserve a higher counter.
    db.migration_state.insert_one(
        {"_id": "supabase-to-mongo", "snapshot_id": bundle.manifest["snapshot_id"], "status": "in_progress"}
    )
    db.counters.insert_one({"_id": "post", "value": 99})
    result = import_bundle(db, bundle, apply=True)
    assert result["applied"]
    assert verify_bundle(db, bundle)["ok"]
    assert db.profiles.find_one({"user_id": USER1})["avatar_url"] == avatar_id
    assert "avatar_pending" not in db.profiles.find_one({"user_id": USER1})
    assert db.avatars.find_one({"id": avatar_id})["data"] == blob
    assert db.members.find_one({"user_id": USER1})["email"] == "u1@example.test"
    assert db.feedback.find_one({"id": 21})["user_id"] == USER1
    assert db.post_votes.count_documents({"post_id": 12}) == 2
    assert db.posts.find_one({"id": 12})["created_at"].tzinfo is not None
    assert db.counters.find_one({"_id": "post"})["value"] == 99
    assert db.counters.find_one({"_id": "reply"})["value"] == 20
    assert db.migration_state.find_one({"_id": "supabase-to-mongo"})["status"] == "complete"
    rerun = import_bundle(db, bundle, apply=True)
    assert not rerun["applied"] and rerun["already_complete"]
    assert import_bundle(db, bundle)["already_complete"]
    assert db.posts.count_documents({}) == 1
    db.posts.update_one({"id": 12}, {"$set": {"title": "Changed by app"}})
    with pytest.raises(MigrationError, match="completed snapshot differs"):
        import_bundle(db, bundle, apply=True)
    with pytest.raises(MigrationError, match="completed snapshot differs"):
        import_bundle(db, bundle)
    assert db.posts.find_one({"id": 12})["title"] == "Changed by app"


def test_apply_refuses_unmarked_existing_data_without_overwriting(db, tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    clear_db(db)
    db.cohorts.insert_one({"id": 1, "name": "Application seed"})
    with pytest.raises(MigrationError, match="existing managed data"):
        import_bundle(db, bundle, apply=True)
    assert db.cohorts.find_one({"id": 1})["name"] == "Application seed"
    assert db.migration_state.count_documents({}) == 0


def test_apply_resumes_same_snapshot_after_interruption(db, tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    clear_db(db)
    # Model interruption after the resume marker and one collection write.
    db.migration_state.insert_one(
        {"_id": "supabase-to-mongo", "snapshot_id": bundle.manifest["snapshot_id"], "status": "in_progress"}
    )
    db.users.insert_one(dict(bundle.documents["users"][0]))
    with pytest.raises(RuntimeError, match="Migration is incomplete"):
        bootstrap_indexes(db)
    assert db.cohorts.count_documents({}) == 0
    result = import_bundle(db, bundle, apply=True)
    assert result["applied"]
    assert db.migration_state.find_one({"_id": "supabase-to-mongo"})["status"] == "complete"
    assert verify_bundle(db, bundle)["ok"]


def test_validate_rejects_bad_business_ids_and_unsafe_keys(tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    from sa_backend.migration import MigrationBundle

    docs = {key: [dict(row) for row in value] for key, value in bundle.documents.items()}
    docs["feedback"][0]["id"] = True
    with pytest.raises(MigrationError, match="positive integer"):
        validate_bundle(MigrationBundle(bundle.manifest, docs, bundle.avatars))
    docs["feedback"][0]["id"] = 21
    docs["posts"][0]["$set"] = {"title": "injection"}
    with pytest.raises(MigrationError, match="unsupported document key"):
        validate_bundle(MigrationBundle(bundle.manifest, docs, bundle.avatars))

    docs["posts"][0].pop("$set")
    docs["feedback"].append(dict(docs["feedback"][0]))
    manifest = {
        **bundle.manifest,
        "tables": {
            **bundle.manifest["tables"],
            "feedback": {**bundle.manifest["tables"]["feedback"], "count": 2},
        },
    }
    with pytest.raises(MigrationError, match="duplicate id"):
        validate_bundle(MigrationBundle(manifest, docs, bundle.avatars))

    tampered_avatars = dict(bundle.avatars)
    avatar_id = next(iter(tampered_avatars))
    tampered_avatars[avatar_id] = b"altered"
    with pytest.raises(MigrationError, match="size or sha256 mismatch"):
        validate_bundle(MigrationBundle(bundle.manifest, bundle.documents, tampered_avatars))


def test_validate_rejects_bad_booleans_and_conflicting_feedback_identity(tmp_path):
    path, _, _, _, _ = make_bundle(tmp_path)
    bundle = load_bundle(path)
    from sa_backend.migration import MigrationBundle

    docs = {key: [dict(row) for row in value] for key, value in bundle.documents.items()}
    docs["posts"][0]["is_anonymous"] = "false"
    with pytest.raises(MigrationError, match="expected boolean"):
        validate_bundle(MigrationBundle(bundle.manifest, docs, bundle.avatars))

    docs["posts"][0]["is_anonymous"] = False
    docs["feedback"][0]["user_id"] = USER2
    with pytest.raises(MigrationError, match="author_id and user_id disagree"):
        validate_bundle(MigrationBundle(bundle.manifest, docs, bundle.avatars))
