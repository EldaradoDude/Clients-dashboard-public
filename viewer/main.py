"""Local web viewer: the last L2 snapshot, and accounts' trades and balances, for a time period.

A FastAPI app. Run `.venv/Scripts/python.exe app.py` (or `uvicorn app:app --port 8050`)
and open http://127.0.0.1:8050. The page lives in static/ (index.html, css/, js/) and is served
as-is. The API is described at /docs; its request and response models are in schemas.py.

Everything needs a login (auth.py) except login.html, its script and the stylesheet; pages
redirect to login.html, API calls get 401. Users are managed with manage.py.

Endpoints (times are epoch ms, the period is half-open [start, end)):
  GET /api/options                                   venues, accounts and symbols
  GET /api/orderbook?venue=&symbol=&start=&end=      last snapshot in the period
  GET /api/depth?venue=&symbol=&start=&end=          1-minute market depth (2% of mid) and
                                                     spread percent buckets
  GET /api/mid?venue=&symbol=&start=&end=            1-minute best bid/ask and mid buckets
  GET /api/balance?account=&symbol=&start=&end=     per account: latest balance and 1-minute
                                                     balance buckets
  GET /api/trades?account=&symbol=&start=&end=      trades in the period (newest first), summary,
                                                     and per account summary and 1-minute quote buckets

  `account` is venue:account and can be repeated; `symbol` is a pair in any venue's format, and
  each account's venue symbol for it is used.

  POST /api/login, POST /api/logout, GET /api/me    see auth.py

Each user sees only what is granted to them (access.py): /api/options lists it, and other
venues, accounts and symbols are refused with 403.

Errors are {"error": message}: 400 for invalid parameters, 401 when not logged in, 403 for what
isn't granted, 500 otherwise.
"""

from __future__ import annotations

import heapq
import json
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Callable
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from sqlalchemy import inspect
from starlette.exceptions import HTTPException as StarletteHTTPException

from access import Accounts, AccountSelection, Market, UserGrants
from auth import CurrentUser, User, current_user, optional_user, router as auth_router
from config import QueryConfig
from query import (
    BALANCE_FIELDS, build_activity_query, build_balance_query, build_c2_balance_query, build_c2_trades_query,
    build_depth_query, build_l2_query, build_mid_query, fetch_filter_values, get_client, is_userdata_account,
    split_pair,
)
from schemas import (
    AccountBalance, AccountTrades, BalanceResponse, MarketBucketsResponse, MarketQuery, OrderbookResponse,
    TradesResponse, VenueOptions,
)
from trades import normalize_c2_trade, normalize_trade, quote_buckets, summarize
from users import get_sessionmaker

HOST, PORT = "127.0.0.1", 8050
STATIC_DIR = Path(__file__).with_name("static").resolve()
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
NO_STORE = {"Cache-Control": "no-store"}
# Served without a login: the login page needs them.
PUBLIC_FILES = {"login.html", "js/login-page.js", "js/api.js", "js/dom.js", "css/style.css"}
LOGIN_PAGE = "/login.html"
TRADE_LIMIT = 5000  # rows sent for the trades table
MAX_TRADE_ROWS = 1_000_000  # trades read per request (summary and delta chart)
DELTA_BUCKET_MS = 60_000  # the page combines these into the chart interval
MARKET_BUCKET_MS = 60_000  # likewise for the market depth and spread charts
BOOK_COLUMNS = ["exchange_ts_ms", "receive_ts_ms", "bid_prices", "bid_amounts", "ask_prices", "ask_amounts"]


class ClickHouse:
    """One client shared by the request threads (FastAPI's thread pool); a clickhouse-connect
    session cannot run concurrent queries, so access is serialized."""

    def __init__(self) -> None:
        self._client = get_client()
        self._lock = threading.Lock()
        self._options: dict[str, Any] | None = None

    def query(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._client.query(sql, parameters=params).named_results())

    def options(self) -> dict[str, Any]:
        # Distinct values take a couple of seconds on l2_snapshots, so they are read once.
        # Restart the server to pick up new venues, accounts or symbols.
        with self._lock:
            if self._options is None:
                self._options = fetch_filter_values(self._client)
            return self._options

    def close(self) -> None:
        self._client.close()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.users_db = get_sessionmaker()
    if not inspect(app.state.users_db.kw["bind"]).has_table("sessions"):
        raise RuntimeError("The users database is not up to date: run `python -m alembic upgrade head`.")
    app.state.db = ClickHouse()
    yield
    app.state.db.close()


# The docs routes are added below, behind the login.
app = FastAPI(title="ClickHouse viewer", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def get_db(request: Request) -> ClickHouse:
    return request.app.state.db


Db = Annotated[ClickHouse, Depends(get_db)]


# ---- errors ----

def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status, NO_STORE)


def _describe(error: dict[str, Any]) -> str:
    """'start: Input should be a valid integer' for one pydantic validation error."""
    where = ".".join(str(part) for part in error["loc"][1:])  # loc[0] is "query"
    message = error["msg"].removeprefix("Value error, ")
    return f"{where}: {message}" if where else message


@app.exception_handler(RequestValidationError)
def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    return _error(400, "; ".join(_describe(e) for e in exc.errors()))


@app.exception_handler(StarletteHTTPException)
def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(ValueError)
def invalid_value(request: Request, exc: ValueError) -> JSONResponse:
    return _error(400, str(exc))


@app.exception_handler(Exception)
def server_error(request: Request, exc: Exception) -> JSONResponse:
    traceback.print_exception(exc)
    return _error(500, f"{type(exc).__name__}: {exc}")


@app.middleware("http")
async def no_store(request: Request, call_next: Callable[[Request], Any]) -> Response:
    response = await call_next(request)
    response.headers.update(NO_STORE)
    return response


@app.middleware("http")
async def same_origin_writes(request: Request, call_next: Callable[[Request], Any]) -> Response:
    """Refuse POSTs (and other writes) sent by another site's page. The SameSite cookie already
    keeps them logged out; this also covers login, which needs no cookie."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin is not None and urlsplit(origin).netloc != request.headers.get("host"):
            return _error(403, "Cross-site request refused.")
    return await call_next(request)


app.include_router(auth_router)


# ---- API ----
# Endpoints are sync: FastAPI runs them in its thread pool, so blocking queries don't stall the server.
# Every route on `api` needs a logged-in user; Market and Accounts parameters are checked against
# the user's grants.

api = APIRouter(prefix="/api", dependencies=[Depends(current_user)])


@api.get("/options")
def options(db: Db, grants: UserGrants) -> dict[str, VenueOptions]:
    """Per venue: its granted symbols, and its granted accounts with the granted symbols each traded."""
    return grants.filter_options(db.options())


@api.get("/orderbook")
def orderbook(q: Market, db: Db) -> OrderbookResponse:
    cfg = QueryConfig(
        venues=[q.venue],
        symbols=[q.symbol],
        start=q.start,
        end=q.end,
        # receive_ts_ms is in the table's sorting key, so the latest row is cheap to find.
        l2_time_column="receive_ts_ms",
        l2_columns=BOOK_COLUMNS,
        limit=1,
    )
    rows = db.query(*build_l2_query(cfg, descending=True))
    return OrderbookResponse(snapshot=rows[0] if rows else None)


def _market_buckets(q: MarketQuery, db: ClickHouse, build: Callable[..., tuple[str, dict[str, Any]]]) -> MarketBucketsResponse:
    """Per-minute rows of [start_ms, *sums, count] from build_depth_query or build_mid_query."""
    cfg = QueryConfig(
        venues=[q.venue],
        symbols=[q.symbol],
        start=q.start,
        end=q.end,
        limit=None,  # at most one row per minute of the period
    )
    rows = db.query(*build(cfg, MARKET_BUCKET_MS))
    return MarketBucketsResponse(bucket_ms=MARKET_BUCKET_MS, buckets=[tuple(r.values()) for r in rows])


@api.get("/depth")
def depth(q: Market, db: Db) -> MarketBucketsResponse:
    """Buckets of [start_ms, bid_depth_sum, ask_depth_sum, spread_percent_sum, snapshot count],
    depths being the quote value within 2% of mid."""
    return _market_buckets(q, db, build_depth_query)


@api.get("/mid")
def mid(q: Market, db: Db) -> MarketBucketsResponse:
    """Buckets of [start_ms, best_bid_sum, best_ask_sum, mid_price_sum, snapshot count]."""
    return _market_buckets(q, db, build_mid_query)


def _split_accounts(q: AccountSelection) -> tuple[list[tuple[str, str, str]], list[tuple[str, str, str]]]:
    """q.account_symbols split into (account_activity / position_snapshots ones, userdata ones)."""
    legacy = [k for k in q.account_symbols if not is_userdata_account(k[1])]
    userdata = [k for k in q.account_symbols if is_userdata_account(k[1])]
    return legacy, userdata


def _carry_forward(series: list[dict[str, Any]]) -> None:
    """Fill each balance field a bucket lacks with the previous bucket's value: c2_balances rows
    report one asset at a time."""
    previous: dict[str, Any] = {}
    for row in series:
        for f in BALANCE_FIELDS:
            if row[f] is None:
                row[f] = previous.get(f)
        previous = row


@api.get("/balance")
def balance(q: Accounts, db: Db) -> BalanceResponse:
    """Per account: its latest balance in the period, and per minute the latest values."""
    legacy, userdata = _split_accounts(q)
    rows: dict[tuple[str, str], list[dict[str, Any]]] = {key: [] for key in q.accounts}
    # At most one row per account and minute of the period, so no limit.
    for account_symbols, build in ((legacy, build_balance_query), (userdata, build_c2_balance_query)):
        if account_symbols:
            cfg = QueryConfig(account_symbols=account_symbols, start=q.start, end=q.end, limit=None)
            for row in db.query(*build(cfg, MARKET_BUCKET_MS)):
                rows[row["venue"], row["account"]].append(row)
    for (venue, account), series in rows.items():
        if is_userdata_account(account):
            _carry_forward(series)
    return BalanceResponse(
        bucket_ms=MARKET_BUCKET_MS,
        accounts=[
            AccountBalance(
                venue=venue,
                account=account,
                latest=series[-1] if series else None,
                buckets=[(r["start_ms"], *(r[f] for f in BALANCE_FIELDS)) for r in series],
            )
            for (venue, account), series in rows.items()
        ],
    )


@api.get("/trades")
def trades(q: Accounts, db: Db) -> TradesResponse:
    """All trades in the period feed the summaries and the delta buckets; only the newest
    TRADE_LIMIT (of all accounts together) are returned as rows for the table."""
    legacy, userdata = _split_accounts(q)
    # (dedupe key, trade) pairs, each source newest first.
    sources: list[list[tuple[tuple[Any, ...], dict[str, Any]]]] = []
    if legacy:
        cfg = QueryConfig(
            account_symbols=legacy,
            kinds=["trade"],
            start=q.start,
            end=q.end,
            activity_columns=["venue", "account", "event_time_ms", "venue_id", "payload"],
            limit=MAX_TRADE_ROWS + 1,
        )
        # account_activity is a ReplacingMergeTree; unmerged duplicates can still be returned.
        # venue_id is only unique within an account.
        sources.append([
            ((row["venue"], row["account"], row["venue_id"]),
             {"venue": row["venue"], "account": row["account"], "time_ms": row["event_time_ms"],
              **normalize_trade(json.loads(row["payload"]))})
            for row in db.query(*build_activity_query(cfg, descending=True))
        ])
    if userdata:
        cfg = QueryConfig(account_symbols=userdata, start=q.start, end=q.end, limit=MAX_TRADE_ROWS + 1)
        # A fill can be stored twice (websocket and backfill) under different dedupe keys; a
        # trade_id with two order_ids is a self-trade, both legs ours. Rows without a trade_id
        # are per-order backfills, kept by their own key.
        sources.append([
            ((row["venue"], row["account"], "t", row["trade_id"], row["order_id"]) if row["trade_id"]
             else (row["venue"], row["account"], "d", row["dedupe"]),
             {"venue": row["venue"], "account": row["account"], "time_ms": row["event_ms"],
              **normalize_c2_trade(row)})
            for row in db.query(*build_c2_trades_query(cfg, descending=True))
        ])
    if sum(len(s) for s in sources) > MAX_TRADE_ROWS:
        raise ValueError(f"More than {MAX_TRADE_ROWS:,} trades in this period; choose a shorter one.")

    result, seen = [], set()
    per_account: dict[tuple[str, str], list[dict[str, Any]]] = {key: [] for key in q.accounts}
    for key, trade in heapq.merge(*sources, key=lambda kt: -kt[1]["time_ms"]):
        if key in seen:
            continue
        seen.add(key)
        result.append(trade)
        per_account[trade["venue"], trade["account"]].append(trade)
    try:
        base, quote_asset = split_pair(q.account_symbols[0][2])
    except ValueError:
        base = quote_asset = None
    accounts = []
    for (venue, account), series in per_account.items():
        summary = summarize(series)
        fee_currencies = sorted(summary["fees"])
        accounts.append(AccountTrades(
            venue=venue,
            account=account,
            summary=summary,
            fee_currencies=fee_currencies,
            buckets=quote_buckets(series, DELTA_BUCKET_MS, fee_currencies),
        ))
    return TradesResponse(
        trades=result[:TRADE_LIMIT],
        total=len(result),
        limit=TRADE_LIMIT,
        summary=summarize(result),
        base=base,
        quote=quote_asset,
        bucket_ms=DELTA_BUCKET_MS,
        accounts=accounts,
    )


app.include_router(api)


# ---- pages ----

OptionalUser = Annotated[User | None, Depends(optional_user)]


def _to_login(request: Request) -> RedirectResponse:
    """Redirect to the login page, which returns to this URL afterwards."""
    here = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    return RedirectResponse(f"{LOGIN_PAGE}?next={quote(here)}", 303)


@app.get("/docs", include_in_schema=False)
def docs(request: Request, user: OptionalUser) -> Response:
    if user is None:
        return _to_login(request)
    return get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} API")


@app.get("/openapi.json", include_in_schema=False)
def openapi(user: CurrentUser) -> dict[str, Any]:
    return app.openapi()


def _static_file(url_path: str) -> Path | None:
    """The file under static/ for a URL path, or None if there is no such servable file."""
    path = (STATIC_DIR / (url_path.lstrip("/") or "index.html")).resolve()
    if path.is_relative_to(STATIC_DIR) and path.is_file() and path.suffix in CONTENT_TYPES:
        return path
    return None


# Not StaticFiles: it takes content types from the system, and Windows can map .js to text/plain,
# which browsers refuse for ES modules.
@app.get("/{url_path:path}", include_in_schema=False)
def static_file(url_path: str, request: Request, user: OptionalUser) -> Response:
    path = _static_file(url_path)
    if path is None:
        return _error(404, f"Not found: /{url_path}")
    if user is None and path.relative_to(STATIC_DIR).as_posix() not in PUBLIC_FILES:
        return _to_login(request) if path.suffix == ".html" else _error(401, "Not logged in.")
    if user is not None and path.name == "login.html":
        return RedirectResponse("/", 303)
    return FileResponse(path, media_type=CONTENT_TYPES[path.suffix])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
