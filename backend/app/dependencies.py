from fastapi import Depends, HTTPException, Request

from .auth.service import current_claims


def database(request: Request):
    return request.app.state.db


def current_user(db=Depends(database), claims: dict = Depends(current_claims)):
    user = db.users.find_one({"id": claims["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User no longer exists")
    return user
