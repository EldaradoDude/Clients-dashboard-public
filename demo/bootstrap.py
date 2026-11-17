"""Demo only: create the login DEMO_USER / DEMO_PASSWORD and grant it every account and symbol in
ClickHouse. `python -m demo.bootstrap`, after `alembic upgrade head` and the seeder's first run.

Real deployments use manage.py, which prompts for passwords instead of reading them from the
environment.
"""

from __future__ import annotations

import argparse
import os

import manage
from viewer.users import User, find_user, get_sessionmaker, hash_password


def main() -> None:
    name = os.getenv("DEMO_USER", "demo")
    password = os.environ["DEMO_PASSWORD"]
    with get_sessionmaker().begin() as session:
        user = find_user(session, name)
        if user is None:
            session.add(User(username=name, password_hash=hash_password(password)))
            session.flush()
        print(manage.grant_all(session, argparse.Namespace(name=name)))
    print(f"Demo login: {name} / {password}")


if __name__ == "__main__":
    main()
