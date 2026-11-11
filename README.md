# Trading Viewer

A web dashboard for market-making data stored in ClickHouse: order book depth and spread,
the latest L2 snapshot, and the trades and balances of one or more trading accounts across
several crypto exchanges.

Built with Python (FastAPI, pandas, SQLAlchemy) and a vanilla-JS front end with
hand-written SVG charts, with no build step.

## Features

- **Order book**: market depth (quote value within 2% of mid) and spread charts over time,
  plus the last L2 snapshot as a ladder with price grouping, quote-currency sizes and
  cumulative totals.
- **Trades**: every fill of the selected accounts in a period, deduplicated across sources,
  with summary stats (buy/sell volume, net position and its price, PnL, fees per currency) and a
  per-minute trade-delta chart.
- **Balances**: latest base/quote balances per account and combined, with available and
  reserved charts over time.
- **Overview**: market, balance and trade stats on one page.
- **Multi-venue**: one pair can be followed across exchanges whose symbol formats differ
  (`ABC_USDT`, `ABC-USDT`, `ABCUSDT`).
- **Charts**: interval switching (1m to 1d) re-aggregates the server's 1-minute buckets in the
  browser, so it needs no new request.

## Security

- Login with Argon2id password hashes and server-side sessions (only a SHA-256 of the session
  token is stored). Cookies are HttpOnly, Secure and SameSite=Lax, with idle and absolute expiry.
- Per-user grants: each user sees only the accounts and symbols granted to them. Every data
  endpoint checks them and returns 403 for anything else.
- Same-origin check for state-changing requests. Every query parameter is bound server-side and
  never formatted into SQL. Column names are checked against fixed lists.
- User management through a CLI (`manage.py`). Passwords are always prompted, never passed as
  arguments.

## Architecture

```
browser (static/, ES modules)
   │  /api/*  (JSON)
   ▼
FastAPI app (app.py)
   ├── auth.py / access.py / users.py   login, sessions, grants  →  SQLite / any SQLAlchemy DB (Alembic migrations)
   ├── schemas.py                       Pydantic request/response models
   ├── query.py                         SQL builders + ClickHouse client  →  ClickHouse
   └── trades.py                        normalizes venue-specific trade payloads, summaries, buckets
```

Heavy aggregation (per-minute buckets, latest balance per account) runs in ClickHouse. The
app normalizes and merges the results, and the browser renders them.

## Data model (ClickHouse)

| Table | Contents |
|---|---|
| `trading.l2_snapshots` | L2 order book snapshots (bid/ask price and amount arrays per snapshot) |
| `trading.account_activity` | Orders and trades per venue and account (raw venue JSON payload) |
| `observability.mm_market_depth` / `mm_market_mid` | Per-snapshot depth, spread, best bid/ask and mid |
| `state.position_snapshots` | Balance snapshots published by the trading algorithms |
| `userdata.c2_trades` / `c2_balances` | Trades and balances of `client2-*` accounts, from a separate ingestion pipeline |

The names above are placeholders. Account names such as `client1-mexc` and pairs such as
`ABCUSDT` in the examples are made up.

## Running locally

Requires Python 3.11 and access to a ClickHouse instance with the tables above.

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # .venv/bin/pip on Linux/macOS

cp credentials.example.json credentials.json        # ClickHouse connection (git-ignored)
cp config.example.json config.json                  # filters for query.py (git-ignored)

.venv/Scripts/python -m alembic upgrade head          # create the users database
.venv/Scripts/python manage.py add-user alice
.venv/Scripts/python manage.py grant-all alice        # or grant-account / grant-symbol

.venv/Scripts/python app.py                           # http://127.0.0.1:8050
```

The ClickHouse connection can also come from the `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`,
`CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` and `CLICKHOUSE_SECURE` environment variables. The
users database defaults to `users.db` (SQLite). Set `VIEWER_DB_URL` to use another one.

## Deployment

It runs as a single uvicorn worker behind Caddy (automatic HTTPS) on a Linux VM, managed by
systemd. There is one worker because the ClickHouse client is shared behind a lock and the
users database is SQLite.
