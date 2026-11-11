"""Viewer users and what each may see, in a SQLAlchemy database (SQLite by default).

A user sees only what is granted to them: accounts (venue, account) for balances and trades,
and symbols (venue, symbol) for market data. Grants are explicit and managed with manage.py.
Logged-in browsers have a row in sessions (see auth.py).

The database URL is VIEWER_DB_URL, by default users.db next to this file. Create or upgrade
the schema with `.venv/Scripts/python.exe -m alembic upgrade head` (migrations in alembic/).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from pwdlib import PasswordHash
from sqlalchemy import DateTime, Engine, ForeignKey, String, create_engine, event, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

DATABASE_URL = os.getenv("VIEWER_DB_URL", f"sqlite:///{Path(__file__).with_name('users.db')}")
MIN_PASSWORD_LENGTH = 12

_password_hash = PasswordHash.recommended()  # Argon2id


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)  # stored lowercase
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    accounts: Mapped[list[AccountGrant]] = relationship(
        back_populates="user", cascade="all, delete-orphan", order_by="(AccountGrant.venue, AccountGrant.account)"
    )
    symbols: Mapped[list[SymbolGrant]] = relationship(
        back_populates="user", cascade="all, delete-orphan", order_by="(SymbolGrant.venue, SymbolGrant.symbol)"
    )
    sessions: Mapped[list[UserSession]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AccountGrant(Base):
    """The user may see this account's balances and trades."""

    __tablename__ = "account_grants"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    venue: Mapped[str] = mapped_column(String(64), primary_key=True)
    account: Mapped[str] = mapped_column(String(128), primary_key=True)

    user: Mapped[User] = relationship(back_populates="accounts")


class SymbolGrant(Base):
    """The user may see this symbol's market data, and pick it for their accounts' balances and trades."""

    __tablename__ = "symbol_grants"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    venue: Mapped[str] = mapped_column(String(64), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), primary_key=True)

    user: Mapped[User] = relationship(back_populates="symbols")


class UserSession(Base):
    """A logged-in browser. The cookie holds a random token; only its SHA-256 is stored, so the
    table can't be used to take over sessions."""

    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship(back_populates="sessions")


def get_engine(url: str = DATABASE_URL) -> Engine:
    engine = create_engine(url)
    if engine.dialect.name == "sqlite":
        # SQLite ignores foreign keys (and so ON DELETE CASCADE) unless each connection enables them.
        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, connection_record) -> None:
            dbapi_connection.execute("PRAGMA foreign_keys = ON")

    return engine


def get_sessionmaker(url: str = DATABASE_URL) -> sessionmaker[Session]:
    return sessionmaker(get_engine(url), expire_on_commit=False)


# ---- passwords ----

def check_password_policy(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"The password must have at least {MIN_PASSWORD_LENGTH} characters.")


def hash_password(password: str) -> str:
    check_password_policy(password)
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str) -> tuple[bool, str | None]:
    """Whether the password matches, and a new hash to store if the old one uses outdated parameters."""
    return _password_hash.verify_and_update(password, password_hash)


# Verified when there is no such user, so a login takes as long whether or not the name exists.
_DUMMY_HASH = _password_hash.hash("no such user")


def authenticate(session: Session, username: str, password: str) -> User | None:
    """The active user with this name and password, or None. Upgrades an outdated password hash."""
    user = find_user(session, username)
    valid, new_hash = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not valid or not user.is_active:
        return None
    if new_hash is not None:
        user.password_hash = new_hash
    return user


# ---- lookups ----

def normalize_username(username: str) -> str:
    return username.strip().lower()


def find_user(session: Session, username: str) -> User | None:
    return session.scalar(select(User).where(User.username == normalize_username(username)))
