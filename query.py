"""Query trading data from ClickHouse.

Two tables are supported:
  * l2_snapshots      - L2 orderbook snapshots (filtered by venue, symbol, time)
  * account_activity  - account events (filtered by venue, account, symbol, kind, time)

plus the mm_market_depth view (bid/ask quote depth within 2% of mid and spread percent per
snapshot) and the mm_market_mid view (best bid/ask and mid per snapshot), read as per-interval
aggregates by build_depth_query and build_mid_query, and account balances per interval
(build_balance_query).

Edit config.json (or build your own QueryConfig) and call
fetch_l2_snapshots / fetch_account_activity.
"""

from __future__ import annotations

from typing import Any

import clickhouse_connect
import pandas as pd
from clickhouse_connect.driver.client import Client

from config import CONFIG, CREDENTIALS, ConnectionConfig, QueryConfig

DATABASE = "trading"
L2_TABLE = f"{DATABASE}.l2_snapshots"
ACTIVITY_TABLE = f"{DATABASE}.account_activity"
# A view over l2_snapshots. Its observed_at is derived from receive_ts_ms, so a time filter
# on it can't use the l2_snapshots sorting key: every row of the symbol is read.
DEPTH_TABLE = "observability.mm_market_depth"
# Also a view over l2_snapshots, but it has receive_ts_ms, so time filters are fast.
MID_TABLE = "observability.mm_market_mid"
# Position snapshots: one JSON payload per algorithm and publish, with a balance per venue.
# The observability.mm_position_venues view unpacks them but drops the venue's
# accountId, so balances are read from here with the same extraction.
POSITION_TABLE = "state.position_snapshots"
BALANCE_FIELDS = [f"{asset}_{part}" for asset in ("base", "quote") for part in ("total", "available", "reserved")]

# Accounts whose trades and balances live in userdata instead of account_activity and
# position_snapshots. Its tables are ReplacingMergeTrees on (venue, event_ms, dedupe), with
# typed columns materialized from the JSON payload.
USERDATA_ACCOUNT_PREFIX = "client2-"
C2_TRADES_TABLE = "userdata.c2_trades"
C2_BALANCES_TABLE = "userdata.c2_balances"  # one row per change of one asset's balance
# Balances before the period are read back this far, so its first bucket has every asset's value.
C2_BALANCE_LOOKBACK_MS = 7 * 24 * 3600 * 1000
# Quote assets recognized at the end of a symbol without a separator (mexc/weex ABCUSDT).
QUOTE_ASSETS = sorted(("USDT", "USDC", "FDUSD", "BUSD", "USD", "BTC", "ETH", "EUR", "TRY"), key=len, reverse=True)

L2_COLUMNS = [
    "exchange_ts_ms", "receive_ts_ms", "source_sequence", "bootstrap", "venue", "symbol",
    "bid_prices", "bid_amounts", "ask_prices", "ask_amounts",
    "source_to_receive_ms", "ingested_at", "kafka_to_clickhouse_ms",
    "bid_prices_decimal", "bid_amounts_decimal", "ask_prices_decimal", "ask_amounts_decimal",
]
ACTIVITY_COLUMNS = [
    "schema", "venue", "account", "symbol", "kind", "venue_id",
    "event_time_ms", "observed_ms", "payload",
]

L2_TIME_COLUMNS = ("exchange_ts_ms", "receive_ts_ms")
ACTIVITY_TIME_COLUMNS = ("event_time_ms", "observed_ms")


def get_client(conn: ConnectionConfig | None = None) -> Client:
    conn = conn or CREDENTIALS
    return clickhouse_connect.get_client(
        host=conn.host,
        port=conn.port,
        username=conn.username,
        password=conn.password,
        secure=conn.secure,
    )


def _select_list(requested: list[str] | None, allowed: list[str]) -> str:
    columns = requested or allowed
    unknown = [c for c in columns if c not in allowed]
    if unknown:
        raise ValueError(f"Unknown columns: {unknown}")
    return ", ".join(f"`{c}`" for c in columns)


def pair_key(symbol: str) -> str:
    """The venue-independent name of a symbol: ABC_USDT (gate), ABC-USDT (kucoin) and ABCUSDT (mexc)
    are all ABCUSDT."""
    return symbol.replace("_", "").replace("-", "").upper()


def split_pair(symbol: str) -> tuple[str, str]:
    """(base, quote) assets of a symbol in any venue's format: ABC_USDT, ABC-USDT, ABCUSDT."""
    for sep in ("_", "-", "/"):
        if sep in symbol:
            base, quote = symbol.upper().split(sep, 1)
            return base, quote
    upper = symbol.upper()
    for quote in QUOTE_ASSETS:
        if upper.endswith(quote) and len(upper) > len(quote):
            return upper[: -len(quote)], quote
    raise ValueError(f"Can't tell the base and quote assets of {symbol}.")


def is_userdata_account(account: str) -> bool:
    """Whether the account's trades and balances are read from userdata."""
    return account.startswith(USERDATA_ACCOUNT_PREFIX)


def _account_symbol_filter(cfg: QueryConfig, columns: str) -> tuple[list[str], dict[str, Any]]:
    """The WHERE condition and parameter for cfg.account_symbols; `columns` are the venue, account
    and symbol columns of the query."""
    if not cfg.account_symbols:
        return [], {}
    return (
        [f"({columns}) IN {{account_symbols:Array(Tuple(String, String, String))}}"],
        {"account_symbols": [tuple(k) for k in cfg.account_symbols]},
    )


def _build_query(
    table: str,
    select: str,
    time_column: str,
    filters: dict[str, list[str]],
    cfg: QueryConfig,
    descending: bool = False,
    account_symbols: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Build a parameterized SELECT. Filter values are bound server-side. With account_symbols,
    cfg.account_symbols applies too (the table needs venue, account and symbol columns)."""
    where, params = _account_symbol_filter(cfg, "venue, account, symbol") if account_symbols else ([], {})

    for column, values in filters.items():
        if values:
            where.append(f"`{column}` IN {{{column}:Array(String)}}")
            params[column] = list(values)

    start_ms, end_ms = cfg.time_range_ms()
    if start_ms is not None:
        where.append(f"`{time_column}` >= {{start_ms:Int64}}")
        params["start_ms"] = start_ms
    where.append(f"`{time_column}` < {{end_ms:Int64}}")
    params["end_ms"] = end_ms

    sql = f"SELECT {select} FROM {table}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY `{time_column}`" + (" DESC" if descending else "")
    if cfg.limit is not None:
        sql += f" LIMIT {int(cfg.limit)}"
    return sql, params


def build_l2_query(cfg: QueryConfig, descending: bool = False) -> tuple[str, dict[str, Any]]:
    if cfg.l2_time_column not in L2_TIME_COLUMNS:
        raise ValueError(f"l2_time_column must be one of {L2_TIME_COLUMNS}")
    return _build_query(
        L2_TABLE,
        _select_list(cfg.l2_columns, L2_COLUMNS),
        cfg.l2_time_column,
        {"venue": cfg.venues, "symbol": cfg.symbols},
        cfg,
        descending,
    )


def build_activity_query(cfg: QueryConfig, descending: bool = False) -> tuple[str, dict[str, Any]]:
    if cfg.activity_time_column not in ACTIVITY_TIME_COLUMNS:
        raise ValueError(f"activity_time_column must be one of {ACTIVITY_TIME_COLUMNS}")
    return _build_query(
        ACTIVITY_TABLE,
        _select_list(cfg.activity_columns, ACTIVITY_COLUMNS),
        cfg.activity_time_column,
        {"venue": cfg.venues, "account": cfg.accounts, "symbol": cfg.symbols, "kind": cfg.kinds},
        cfg,
        descending,
        account_symbols=True,
    )


def _build_bucket_query(
    table: str,
    time_ms: str,
    time_filter: tuple[str, str],
    sums: list[str],
    cfg: QueryConfig,
    bucket_ms: int,
) -> tuple[str, dict[str, Any]]:
    """Rows of (start_ms, *sums of the `sums` columns, count) per time bucket, ascending.

    `time_ms` is the row time as epoch ms (an SQL expression); `time_filter` is the column the
    period is compared on and the expression a bound `{name:Int64}` is converted with, e.g.
    ("observed_at", "fromUnixTimestamp64Milli({}, 'UTC')"). Buckets start at multiples of
    bucket_ms since the epoch; empty ones are left out. Sums rather than averages, so buckets
    can be combined further. Uses venues, symbols, the time range and limit (a cap on buckets)."""
    where: list[str] = []
    params: dict[str, Any] = {"bucket_ms": int(bucket_ms)}
    for column, values in {"venue": cfg.venues, "symbol": cfg.symbols}.items():
        if values:
            where.append(f"`{column}` IN {{{column}:Array(String)}}")
            params[column] = list(values)

    column, bound = time_filter
    start_ms, end_ms = cfg.time_range_ms()
    if start_ms is not None:
        where.append(f"{column} >= " + bound.format("{start_ms:Int64}"))
        params["start_ms"] = start_ms
    where.append(f"{column} < " + bound.format("{end_ms:Int64}"))
    params["end_ms"] = end_ms

    select = ", ".join(f"sum(`{c}`) AS `{c}_sum`" for c in sums)
    sql = (
        f"SELECT intDiv({time_ms}, {{bucket_ms:Int64}}) * {{bucket_ms:Int64}} AS start_ms, {select},"
        f" count() AS count FROM {table} WHERE " + " AND ".join(where) +
        " GROUP BY start_ms ORDER BY start_ms"
    )
    if cfg.limit is not None:
        sql += f" LIMIT {int(cfg.limit)}"
    return sql, params


def build_depth_query(cfg: QueryConfig, bucket_ms: int) -> tuple[str, dict[str, Any]]:
    """Per bucket: start_ms, the sums of bid/ask depth and spread percent, and the snapshot count."""
    return _build_bucket_query(
        DEPTH_TABLE,
        "toUnixTimestamp64Milli(observed_at)",
        ("observed_at", "fromUnixTimestamp64Milli({}, 'UTC')"),
        ["bid_depth_2pct_quote", "ask_depth_2pct_quote", "spread_percent"],
        cfg,
        bucket_ms,
    )


def build_mid_query(cfg: QueryConfig, bucket_ms: int) -> tuple[str, dict[str, Any]]:
    """Per bucket: start_ms, the sums of best bid, best ask and mid price, and the snapshot count."""
    return _build_bucket_query(
        MID_TABLE,
        "receive_ts_ms",
        ("receive_ts_ms", "{}"),  # in the l2_snapshots sorting key, unlike observed_at
        ["best_bid", "best_ask", "mid_price"],
        cfg,
        bucket_ms,
    )


def build_balance_query(cfg: QueryConfig, bucket_ms: int) -> tuple[str, dict[str, Any]]:
    """Balance per account and time bucket, ordered by venue, account, start_ms: venue, account,
    start_ms, then for each of BALANCE_FIELDS the latest value in the bucket (NULL if none), then
    base_asset, quote_asset, the account observation time of the latest value (observed_ms) and
    the number of observations (count).

    Several algorithms publish the same account's balance, so "latest" is by the account's own
    observation time, then by publish time. Uses venues, accounts, symbols, account_symbols, the
    time range (on publish time) and limit (a cap on rows) from cfg."""
    params: dict[str, Any] = {"bucket_ms": int(bucket_ms)}
    start_ms, end_ms = cfg.time_range_ms()
    inner_where = ["s.published_at < fromUnixTimestamp64Milli({end_ms:Int64}, 'UTC')"]
    params["end_ms"] = end_ms
    if start_ms is not None:
        inner_where.append("s.published_at >= fromUnixTimestamp64Milli({start_ms:Int64}, 'UTC')")
        params["start_ms"] = start_ms

    # Inner columns are prefixed with v_: an output alias would shadow them in WHERE.
    where, key_params = _account_symbol_filter(cfg, "v_venue, v_account, v_symbol")
    params.update(key_params)
    where.append("(v_base_total IS NOT NULL OR v_quote_total IS NOT NULL)")
    for column, values in {"venue": cfg.venues, "account": cfg.accounts, "symbol": cfg.symbols}.items():
        if values:
            where.append(f"`v_{column}` IN {{{column}:Array(String)}}")
            params[column] = list(values)

    fields = ", ".join(
        "toFloat64OrNull(JSONExtractString(v, '{}', '{}')) AS v_{}".format(*f.split("_"), f)
        for f in BALANCE_FIELDS
    )
    latest = ", ".join(f"argMaxIf(v_{f}, version, v_{f} IS NOT NULL) AS {f}" for f in BALANCE_FIELDS)
    sql = f"""
SELECT
    v_venue AS venue,
    v_account AS account,
    intDiv(toUnixTimestamp64Milli(v_published_at), {{bucket_ms:Int64}}) * {{bucket_ms:Int64}} AS start_ms,
    {latest},
    argMax(v_base_asset, version) AS base_asset,
    argMax(v_quote_asset, version) AS quote_asset,
    toUnixTimestamp64Milli(max(version).1) AS observed_ms,
    count() AS count
FROM (
    SELECT
        s.published_at AS v_published_at,
        JSONExtractString(v, 'venue') AS v_venue,
        JSONExtractString(v, 'accountId') AS v_account,
        JSONExtractString(v, 'symbol') AS v_symbol,
        JSONExtractString(v, 'base', 'asset') AS v_base_asset,
        JSONExtractString(v, 'quote', 'asset') AS v_quote_asset,
        {fields},
        (ifNull(parseDateTime64BestEffortOrNull(JSONExtractString(v, 'observedAt'), 3, 'UTC'), s.published_at),
         s.published_at) AS version
    FROM {POSITION_TABLE} AS s
    ARRAY JOIN JSONExtractArrayRaw(s.payload, 'position', 'venues') AS v
    WHERE {" AND ".join(inner_where)}
)
WHERE {" AND ".join(where)}
GROUP BY venue, account, start_ms
ORDER BY venue, account, start_ms"""
    if cfg.limit is not None:
        sql += f" LIMIT {int(cfg.limit)}"
    return sql, params


def build_c2_trades_query(cfg: QueryConfig, descending: bool = False) -> tuple[str, dict[str, Any]]:
    """Trades of userdata accounts: venue, account, event_ms, dedupe, trade_id, order_id, side
    (BUY/SELL), price, qty, quote_qty (0 when the venue doesn't report it: pionex), maker (NULL if
    unknown), fee, fee_asset (NULL if unknown). Uses account_symbols, the time range and limit.

    The table can hold the same fill twice under different dedupe keys (e.g. from the websocket
    and a backfill), so callers deduplicate on (venue, account, trade_id, order_id): a self-trade
    is one trade_id with a buy and a sell order. Rows without a trade_id are per-order backfills."""
    select = (
        "venue, account, event_ms, dedupe, trade_id, order_id, side, price, qty, quote_qty,"
        " JSONExtract(payload, 'maker', 'Nullable(Bool)') AS maker, fee,"
        " nullIf(fee_asset, '') AS fee_asset"
    )
    sql, params = _build_query(C2_TRADES_TABLE, select, "event_ms", {}, cfg, descending, account_symbols=True)
    return sql, params


def _c2_number(field: str) -> str:
    """A payload number (often a JSON string) as Nullable(Float64): NULL when missing or null,
    where JSONExtractFloat (and the materialized columns) would give 0."""
    return (
        f"if(JSONType(payload, '{field}') IN ('String', 'Double', 'Int64', 'UInt64'),"
        f" toFloat64OrNull(trim(BOTH '\"' FROM JSONExtractRaw(payload, '{field}'))), NULL)"
    )


def build_c2_balance_query(cfg: QueryConfig, bucket_ms: int) -> tuple[str, dict[str, Any]]:
    """Balances of userdata accounts, with the same columns as build_balance_query.

    c2_balances has a row per change of one asset (free, locked, sometimes total), so per bucket
    each field is the latest value of the pair's base or quote asset in it, NULL if that asset
    didn't change; callers carry values forward. Changes up to C2_BALANCE_LOOKBACK_MS before the
    period count towards its first bucket, so it starts with the balance at the period start
    (count only counts changes in the period). Total is the reported total, or free + locked.
    Uses account_symbols (base and quote come from the symbol) and the time range from cfg."""
    if not cfg.account_symbols:
        raise ValueError("build_c2_balance_query needs account_symbols.")
    assets = sorted({(v, a, *split_pair(s)) for v, a, s in cfg.account_symbols})
    start_ms, end_ms = cfg.time_range_ms()
    params: dict[str, Any] = {
        "bucket_ms": int(bucket_ms),
        "end_ms": end_ms,
        "venues": sorted({v for v, *_ in assets}),
        "assets": assets,
        "keys": sorted({(v, a, asset) for v, a, base, quote in assets for asset in (base, quote)}),
        "start_ms": start_ms if start_ms is not None else 0,
        "from_ms": start_ms - C2_BALANCE_LOOKBACK_MS if start_ms is not None else 0,
        "first_bucket": start_ms // bucket_ms * bucket_ms if start_ms is not None else 0,
    }

    def latest(side: str, part: str) -> str:
        return f"argMaxIf(v_{part}, event_ms, is_{side} AND v_{part} IS NOT NULL) AS {side}_{part}"

    fields = ", ".join(latest(*f.split("_")) for f in BALANCE_FIELDS)
    sql = f"""
SELECT
    venue,
    account,
    greatest(intDiv(event_ms, {{bucket_ms:Int64}}) * {{bucket_ms:Int64}}, {{first_bucket:Int64}}) AS start_ms,
    {fields},
    any(v_base) AS base_asset,
    any(v_quote) AS quote_asset,
    max(event_ms) AS observed_ms,
    countIf(event_ms >= {{start_ms:Int64}}) AS count
FROM (
    SELECT
        venue,
        account,
        event_ms,
        arrayFirst(k -> k.1 = venue AND k.2 = account,
                   {{assets:Array(Tuple(String, String, String, String))}}) AS k,
        k.3 AS v_base,
        k.4 AS v_quote,
        asset = v_base AS is_base,
        asset = v_quote AS is_quote,
        {_c2_number('free')} AS v_available,
        {_c2_number('locked')} AS v_reserved,
        ifNull({_c2_number('total')}, v_available + ifNull(v_reserved, 0)) AS v_total
    FROM {C2_BALANCES_TABLE}
    WHERE venue IN {{venues:Array(String)}}
        AND (venue, account, asset) IN {{keys:Array(Tuple(String, String, String))}}
        AND event_ms >= {{from_ms:Int64}} AND event_ms < {{end_ms:Int64}}
)
GROUP BY venue, account, start_ms
ORDER BY venue, account, start_ms"""
    return sql, params


def fetch_filter_values(client: Client | None = None) -> dict[str, dict[str, Any]]:
    """Distinct values per venue: {venue: {"symbols": [...], "accounts": {account: [traded symbols]}}}.

    Symbols come from l2_snapshots and the trade tables. Accounts come from account_activity, except
    userdata accounts (is_userdata_account), which come from c2_trades and c2_balances.
    """
    client = client or get_client()
    venues: dict[str, dict[str, Any]] = {}

    def entry(venue: str) -> dict[str, Any]:
        return venues.setdefault(venue, {"symbols": set(), "accounts": {}})

    for venue, symbol in client.query(f"SELECT DISTINCT venue, symbol FROM {L2_TABLE}").result_rows:
        entry(venue)["symbols"].add(symbol)
    for venue, account, symbol in client.query(
        f"SELECT DISTINCT venue, account, symbol FROM {ACTIVITY_TABLE}"
    ).result_rows:
        if is_userdata_account(account):
            continue
        e = entry(venue)
        e["symbols"].add(symbol)
        e["accounts"].setdefault(account, set()).add(symbol)
    for venue, account, symbol in client.query(
        f"SELECT DISTINCT venue, account, symbol FROM {C2_TRADES_TABLE}"
    ).result_rows:
        if not is_userdata_account(account):
            continue
        e = entry(venue)
        e["symbols"].add(symbol)
        e["accounts"].setdefault(account, set()).add(symbol)
    for venue, account in client.query(f"SELECT DISTINCT venue, account FROM {C2_BALANCES_TABLE}").result_rows:
        if is_userdata_account(account):
            entry(venue)["accounts"].setdefault(account, set())

    return {
        venue: {
            "symbols": sorted(e["symbols"]),
            "accounts": {a: sorted(s) for a, s in sorted(e["accounts"].items())},
        }
        for venue, e in sorted(venues.items())
    }


def fetch_l2_snapshots(cfg: QueryConfig = CONFIG, client: Client | None = None) -> pd.DataFrame:
    sql, params = build_l2_query(cfg)
    return (client or get_client()).query_df(sql, parameters=params)


def fetch_account_activity(cfg: QueryConfig = CONFIG, client: Client | None = None) -> pd.DataFrame:
    sql, params = build_activity_query(cfg)
    return (client or get_client()).query_df(sql, parameters=params)


if __name__ == "__main__":
    client = get_client()

    l2 = fetch_l2_snapshots(CONFIG, client)
    print(f"l2_snapshots: {len(l2)} rows")
    print(l2.head())

    activity = fetch_account_activity(CONFIG, client)
    print(f"\naccount_activity: {len(activity)} rows")
    print(activity.head())
