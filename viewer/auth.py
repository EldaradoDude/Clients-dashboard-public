"""Login and server-side sessions for the viewer (users and sessions tables in users.py).

The session cookie holds a random token. It is HttpOnly (scripts can't read it), Secure (sent
only over HTTPS; browsers treat http://localhost and 127.0.0.1 as secure too) and SameSite=Lax
(not sent with cross-site POSTs). A session ends after IDLE_TIMEOUT without requests, after
SESSION_LIFETIME in total, on logout, or when the user is disabled or gets a new password.

  POST /api/login   {"username", "password"} -> {"username"}, sets the cookie
  POST /api/logout  ends the session and clears the cookie
  GET  /api/me      {"username"} of the logged-in user, else 401
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_
from sqlalchemy.orm import Session

from users import User, UserSession, authenticate, utcnow

COOKIE_NAME = "viewer_session"
IDLE_TIMEOUT = timedelta(hours=12)
SESSION_LIFETIME = timedelta(days=7)
TOUCH_INTERVAL = timedelta(minutes=5)  # how often last_seen_at is written, to save writes


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _aware(value: datetime) -> datetime:
    # SQLite returns naive datetimes; they are stored in UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def create_session(db: Session, user: User) -> str:
    """Store a new session for the user and return its token (for the cookie)."""
    now = utcnow()
    # Expired sessions are removed here rather than by a background job.
    db.execute(delete(UserSession).where(or_(
        UserSession.created_at < now - SESSION_LIFETIME,
        UserSession.last_seen_at < now - IDLE_TIMEOUT,
    )))
    token = secrets.token_urlsafe(32)
    db.add(UserSession(token_hash=_hash_token(token), user=user, created_at=now, last_seen_at=now))
    return token


def session_user(db: Session, token: str | None) -> User | None:
    """The active user of a valid session token, or None. Ends expired sessions."""
    if not token:
        return None
    session = db.get(UserSession, _hash_token(token))
    if session is None:
        return None
    now = utcnow()
    if (now - _aware(session.created_at) > SESSION_LIFETIME or now - _aware(session.last_seen_at) > IDLE_TIMEOUT
            or not session.user.is_active):
        db.delete(session)
        db.commit()
        return None
    if now - _aware(session.last_seen_at) > TOUCH_INTERVAL:
        session.last_seen_at = now
        db.commit()
    return session.user


def end_user_sessions(db: Session, user: User) -> None:
    """Log the user out everywhere (after a password change or when disabled)."""
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))


# ---- dependencies ----

def get_users_db(request: Request) -> Iterator[Session]:
    with request.app.state.users_db() as db:
        yield db


UsersDb = Annotated[Session, Depends(get_users_db)]


def optional_user(request: Request, db: UsersDb) -> User | None:
    return session_user(db, request.cookies.get(COOKIE_NAME))


def current_user(user: Annotated[User | None, Depends(optional_user)]) -> User:
    if user is None:
        raise HTTPException(401, "Not logged in.")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


# ---- routes ----

class LoginRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=1024)  # bounds the hashing work per request


class Me(BaseModel):
    username: str


router = APIRouter(prefix="/api")


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/", secure=True, httponly=True, samesite="lax",
    )


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response, db: UsersDb) -> Me:
    user = authenticate(db, body.username, body.password)
    if user is None:
        raise HTTPException(401, "Wrong username or password.")
    # Always a new session, so a token planted before login is never promoted.
    old = request.cookies.get(COOKIE_NAME)
    if old:
        db.execute(delete(UserSession).where(UserSession.token_hash == _hash_token(old)))
    token = create_session(db, user)
    db.commit()
    _set_cookie(response, token)
    return Me(username=user.username)


@router.post("/logout")
def logout(request: Request, response: Response, db: UsersDb) -> dict[str, bool]:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.execute(delete(UserSession).where(UserSession.token_hash == _hash_token(token)))
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="lax")
    return {"ok": True}


@router.get("/me")
def me(user: CurrentUser) -> Me:
    return Me(username=user.username)
