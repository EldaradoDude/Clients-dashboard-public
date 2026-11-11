"""Manage viewer users and their grants (users.py). Run with .venv/Scripts/python.exe:

  manage.py add-user NAME                     prompts for the password
  manage.py set-password NAME                 also logs the user out everywhere
  manage.py disable NAME | enable NAME | delete-user NAME
  manage.py grant-account NAME VENUE ACCOUNT  balances and trades of the account
  manage.py grant-symbol NAME VENUE SYMBOL    market data of the symbol
  manage.py grant-all NAME                    every account and symbol now in ClickHouse
  manage.py revoke-account NAME VENUE ACCOUNT | revoke-symbol NAME VENUE SYMBOL
  manage.py list [NAME]

Grants are checked against the venues, accounts and symbols in ClickHouse (--force skips that,
e.g. for an account that has no activity yet). Apply migrations first: `-m alembic upgrade head`.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import end_user_sessions
from users import AccountGrant, SymbolGrant, User, find_user, get_sessionmaker, hash_password, normalize_username


class CommandError(Exception):
    pass


def _user(session: Session, name: str) -> User:
    user = find_user(session, name)
    if user is None:
        raise CommandError(f"No user {name!r}.")
    return user


def _ask_password() -> str:
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat: "):
        raise CommandError("The passwords differ.")
    try:
        return hash_password(password)
    except ValueError as e:
        raise CommandError(str(e)) from None


def _check_exists(venue: str, kind: str, value: str | None = None) -> None:
    """Fail unless ClickHouse knows the venue and, for kind "account"/"symbol", the value."""
    from query import fetch_filter_values  # connects to ClickHouse; only needed here

    options = fetch_filter_values()
    if venue not in options:
        raise CommandError(f"Unknown venue {venue!r}; known: {', '.join(options)}. Use --force to grant anyway.")
    known = options[venue]["accounts" if kind == "account" else "symbols"]
    if value not in known:
        raise CommandError(f"Unknown {kind} {value!r} on {venue}. Use --force to grant anyway.")


def add_user(session: Session, args: argparse.Namespace) -> str:
    name = normalize_username(args.name)
    if not name:
        raise CommandError("The name is empty.")
    if find_user(session, name) is not None:
        raise CommandError(f"User {name!r} already exists.")
    session.add(User(username=name, password_hash=_ask_password()))
    return f"Added {name!r}. Grant accounts and symbols with grant-account and grant-symbol."


def set_password(session: Session, args: argparse.Namespace) -> str:
    user = _user(session, args.name)
    user.password_hash = _ask_password()
    end_user_sessions(session, user)
    return "Password changed; the user is logged out everywhere."


def set_active(active: bool):
    def command(session: Session, args: argparse.Namespace) -> str:
        user = _user(session, args.name)
        user.is_active = active
        if not active:
            end_user_sessions(session, user)
        return "Enabled." if active else "Disabled and logged out."

    return command


def delete_user(session: Session, args: argparse.Namespace) -> str:
    session.delete(_user(session, args.name))
    return "Deleted, with the user's grants."


def grant_account(session: Session, args: argparse.Namespace) -> str:
    user = _user(session, args.name)
    if not args.force:
        _check_exists(args.venue, "account", args.account)
    if session.get(AccountGrant, (user.id, args.venue, args.account)) is not None:
        return "Already granted."
    session.add(AccountGrant(user=user, venue=args.venue, account=args.account))
    return f"Granted account {args.venue}/{args.account}."


def grant_symbol(session: Session, args: argparse.Namespace) -> str:
    user = _user(session, args.name)
    if not args.force:
        _check_exists(args.venue, "symbol", args.symbol)
    if session.get(SymbolGrant, (user.id, args.venue, args.symbol)) is not None:
        return "Already granted."
    session.add(SymbolGrant(user=user, venue=args.venue, symbol=args.symbol))
    return f"Granted symbol {args.venue}/{args.symbol}."


def grant_all(session: Session, args: argparse.Namespace) -> str:
    """Grant every account and symbol ClickHouse has now; ones added later need another run."""
    from query import fetch_filter_values  # connects to ClickHouse; only needed here

    user = _user(session, args.name)
    accounts = {(g.venue, g.account) for g in user.accounts}
    symbols = {(g.venue, g.symbol) for g in user.symbols}
    added_accounts = added_symbols = 0
    for venue, options in fetch_filter_values().items():
        for account in options["accounts"]:
            if (venue, account) not in accounts:
                session.add(AccountGrant(user=user, venue=venue, account=account))
                added_accounts += 1
        for symbol in options["symbols"]:
            if (venue, symbol) not in symbols:
                session.add(SymbolGrant(user=user, venue=venue, symbol=symbol))
                added_symbols += 1
    return f"Granted {added_accounts} accounts and {added_symbols} symbols (the rest were already granted)."


def revoke_account(session: Session, args: argparse.Namespace) -> str:
    grant = session.get(AccountGrant, (_user(session, args.name).id, args.venue, args.account))
    if grant is None:
        raise CommandError("No such grant.")
    session.delete(grant)
    return "Revoked."


def revoke_symbol(session: Session, args: argparse.Namespace) -> str:
    grant = session.get(SymbolGrant, (_user(session, args.name).id, args.venue, args.symbol))
    if grant is None:
        raise CommandError("No such grant.")
    session.delete(grant)
    return "Revoked."


def list_users(session: Session, args: argparse.Namespace) -> str:
    users = [_user(session, args.name)] if args.name else session.scalars(select(User).order_by(User.username))
    lines = []
    for user in users:
        state = "" if user.is_active else "  (disabled)"
        lines.append(f"{user.username}{state}  created {user.created_at:%Y-%m-%d %H:%M}")
        lines += [f"  account {g.venue}/{g.account}" for g in user.accounts]
        lines += [f"  symbol  {g.venue}/{g.symbol}" for g in user.symbols]
    return "\n".join(lines) or "No users."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage viewer users and their grants.")
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name: str, handler, *params: str, force: bool = False, optional_name: bool = False) -> None:
        sub = commands.add_parser(name)
        sub.add_argument("name", nargs="?" if optional_name else None)
        for param in params:
            sub.add_argument(param)
        if force:
            sub.add_argument("--force", action="store_true", help="skip the ClickHouse check")
        sub.set_defaults(handler=handler)

    command("add-user", add_user)
    command("set-password", set_password)
    command("disable", set_active(False))
    command("enable", set_active(True))
    command("delete-user", delete_user)
    command("grant-account", grant_account, "venue", "account", force=True)
    command("grant-symbol", grant_symbol, "venue", "symbol", force=True)
    command("grant-all", grant_all)
    command("revoke-account", revoke_account, "venue", "account")
    command("revoke-symbol", revoke_symbol, "venue", "symbol")
    command("list", list_users, optional_name=True)

    args = parser.parse_args(argv)
    try:
        with get_sessionmaker().begin() as session:
            print(args.handler(session, args))
    except CommandError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
