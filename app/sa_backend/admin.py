"""Operator-only tools. No unauthenticated bootstrap HTTP routes."""

import argparse

from pymongo import MongoClient

from .config import get_settings
from .sandbox import active_sandbox_database
from .services import bootstrap_indexes


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    invite = commands.add_parser("create-invite")
    invite.add_argument("code")
    invite.add_argument("--max-uses", type=int)
    grant = commands.add_parser("grant-admin")
    grant.add_argument("email")
    args = parser.parse_args()
    settings = get_settings()
    with MongoClient(settings.mongodb_uri, tz_aware=True) as client:
        db = active_sandbox_database(client, settings)
        bootstrap_indexes(db)
        if args.command == "create-invite":
            code = args.code.strip().upper()
            if not code or (args.max_uses is not None and args.max_uses < 1):
                parser.error("Invite code must be non-empty and max-uses must be positive")
            db.invite_codes.insert_one(
                {"code": code, "max_uses": args.max_uses, "used_count": 0, "is_active": True}
            )
            print("Invite created")
        else:
            user = db.users.find_one({"email": args.email.strip().lower()})
            if not user:
                parser.error("User must sign in and redeem an invite first")
            result = db.members.update_one({"user_id": user["id"]}, {"$set": {"is_admin": True}})
            if not result.matched_count:
                parser.error("User must redeem an invite first")
            print("Admin granted")


if __name__ == "__main__":
    main()
