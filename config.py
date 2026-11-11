"""Configuration for ClickHouse queries.

Edit config.json to choose what query.py loads. Connection settings are read
from credentials.json; keys missing there fall back to environment variables
(see ConnectionConfig).

An empty filter list means "no filter" for that field.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG_PATH = Path(__file__).with_name("config.json")
CREDENTIALS_PATH = Path(__file__).with_name("credentials.json")

# A time bound can be epoch milliseconds, a datetime (naive = UTC),
# or an ISO string such as "2026-10-22 10:00:00" (naive = UTC).
TimeLike = int | datetime | str


@dataclass
class ConnectionConfig:
    host: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_HOST", "localhost"))
    port: int = field(default_factory=lambda: int(os.getenv("CLICKHOUSE_PORT", "8123")))
    username: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_USER", "default"))
    password: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_PASSWORD", ""))
    secure: bool = field(default_factory=lambda: os.getenv("CLICKHOUSE_SECURE", "0") == "1")


@dataclass
class QueryConfig:
    venues: list[str] = field(default_factory=list)
    accounts: list[str] = field(default_factory=list)  # account_activity only
    symbols: list[str] = field(default_factory=list)
    kinds: list[str] = field(default_factory=list)  # account_activity only
    # (venue, account, symbol) triples, for account_activity and balances: when set, a row must
    # match one of them. Unlike the separate lists, this never pairs one venue with another's account.
    account_symbols: list[tuple[str, str, str]] = field(default_factory=list)
    start: TimeLike | None = None
    end: TimeLike | None = None  # None = now
    lookback: timedelta | None = None  # used when start is None: start = end - lookback
    l2_time_column: str = "exchange_ts_ms"
    activity_time_column: str = "event_time_ms"
    l2_columns: list[str] | None = None  # None = all columns
    activity_columns: list[str] | None = None  # None = all columns
    limit: int | None = 100_000  # safety cap; None = unlimited

    def time_range_ms(self) -> tuple[int | None, int]:
        end_ms = to_ms(self.end) if self.end is not None else now_ms()
        if self.start is not None:
            start_ms = to_ms(self.start)
        elif self.lookback is not None:
            start_ms = end_ms - int(self.lookback.total_seconds() * 1000)
        else:
            start_ms = None
        if start_ms is not None and start_ms > end_ms:
            raise ValueError(f"start ({start_ms}) is after end ({end_ms})")
        return start_ms, end_ms


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def to_ms(value: TimeLike) -> int:
    if isinstance(value, bool):
        raise TypeError("bool is not a valid time value")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    raise TypeError(f"Unsupported time value: {value!r}")


def load_config(path: str | Path = CONFIG_PATH) -> QueryConfig:
    """Load a QueryConfig from JSON. "lookback_minutes" maps to QueryConfig.lookback."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    lookback_minutes = data.pop("lookback_minutes", None)
    if lookback_minutes is not None:
        data["lookback"] = timedelta(minutes=lookback_minutes)
    known = {f.name for f in fields(QueryConfig)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown keys in {path}: {sorted(unknown)}")
    return QueryConfig(**data)


def load_credentials(path: str | Path = CREDENTIALS_PATH) -> ConnectionConfig:
    """Load ClickHouse connection settings from JSON."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    known = {f.name for f in fields(ConnectionConfig)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown keys in {path}: {sorted(unknown)}")
    return ConnectionConfig(**data)


CONFIG = load_config()
CREDENTIALS = load_credentials()
