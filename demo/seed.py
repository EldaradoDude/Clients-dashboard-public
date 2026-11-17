"""Fill the demo ClickHouse with synthetic data: `python -m demo.seed [--follow]`.

Everything is generated inside ClickHouse (INSERT ... SELECT FROM numbers()), as a function of
time: prices are a sum of slow waves, and noise comes from hashes of the timestamp. So any time
window can be generated on its own and still joins up with its neighbours, which lets --follow
append new data every few seconds and keeps the dashboard live.

The markets, accounts and pairs below are made up. Balances are not derived from the trades.
Connection: CLICKHOUSE_HOST/PORT/USER/PASSWORD (see viewer/config.py).
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path
from typing import Any

from viewer.config import now_ms
from viewer.query import get_client

DAYS = float(os.getenv("DEMO_DAYS", "7"))  # history generated on the first run
FOLLOW_SECONDS = 10
READY_FILE = Path(os.getenv("DEMO_READY_FILE", "/tmp/seeded"))  # the compose healthcheck waits for it

L2_STEP_MS = 10_000
TRADE_STEP_MS = 20_000  # at most one trade per account and step
BALANCE_STEP_MS = 60_000

ASSETS: dict[str, dict[str, Any]] = {
    # base: price level, phase: shifts the waves, tick: price step, level_gap: ticks between
    # levels, level_quote: typical quote value per level.
    "ABC": dict(base=0.2150, phase=0.7, tick=0.0001, price_dp=4, level_gap=3, level_quote=450.0, amount_dp=1),
    "XYZ": dict(base=1.8420, phase=2.1, tick=0.0001, price_dp=4, level_gap=15, level_quote=1200.0, amount_dp=2),
}
QUOTE = "USDT"

# venue, symbol (in the venue's format), base asset, typical spread in bps, price basis vs. other venues
MARKETS = [
    ("gate", "ABC_USDT", "ABC", 14.0, 0.0003),
    ("kucoin", "ABC-USDT", "ABC", 18.0, -0.0002),
    ("mexc", "ABCUSDT", "ABC", 10.0, 0.0),
    ("pionex", "ABC_USDT", "ABC", 22.0, 0.0005),
    ("weex", "ABCUSDT", "ABC", 26.0, -0.0004),
    ("gate", "XYZ_USDT", "XYZ", 9.0, 0.0001),
    ("mexc", "XYZUSDT", "XYZ", 7.0, -0.0001),
]

# Trade payload templates for ClickHouse format(), one per venue message format. Arguments:
# {0} trade id, {1} order id, {2} side buy/sell, {3} is buyer, {4} price, {5} amount, {6} quote,
# {7} fee, {8} fee currency, {9} role maker/taker, {10} is maker, {11} symbol, {12} side BUY/SELL.
TRADE_TEMPLATES = {
    "gate": '{{"id":{0},"order_id":"{1}","currency_pair":"{11}","side":"{2}","role":"{9}",'
            '"price":"{4}","amount":"{5}","fee":"{7}","fee_currency":"{8}"}}',
    "kucoin": '{{"symbol":"{11}","tradeId":"{0}","orderId":"{1}","side":"{2}","liquidity":"{9}",'
              '"price":"{4}","size":"{5}","funds":"{6}","fee":"{7}","feeCurrency":"{8}"}}',
    "mexc": '{{"symbol":"{11}","id":{0},"orderId":"{1}","isBuyer":{3},"isMaker":{10},"price":"{4}",'
            '"qty":"{5}","quoteQty":"{6}","commission":"{7}","commissionAsset":"{8}"}}',
    # userdata (client2-*) rows; pionex doesn't report the quote quantity.
    "c2": '{{"symbol":"{11}","trade_id":"{0}","order_id":"{1}","client_order_id":"c-{1}","side":"{12}",'
          '"price":"{4}","qty":"{5}","quote_qty":"{6}","maker":{10},"fee":"{7}","fee_asset":"{8}","src":"ws"}}',
    "c2_no_quote": '{{"symbol":"{11}","trade_id":"{0}","order_id":"{1}","client_order_id":"c-{1}","side":"{12}",'
                   '"price":"{4}","qty":"{5}","quote_qty":null,"maker":{10},"fee":"{7}","fee_asset":"{8}","src":"ws"}}',
}
POSITION_TEMPLATE = (
    '{{"algorithmId":"{0}","position":{{"venues":[{{"venue":"{1}","accountId":"{2}","symbol":"{3}",'
    '"observedAt":"{4}","base":{{"asset":"{5}","total":"{6}","available":"{7}","reserved":"{8}"}},'
    '"quote":{{"asset":"{9}","total":"{10}","available":"{11}","reserved":"{12}"}}}}]}}}}'
)
C2_BALANCE_TEMPLATE = '{{"asset":"{0}","free":"{1}","locked":"{2}","src":"ws"}}'

# account, venue, symbol, trade template, trades per 1000 steps, typical trade size in quote,
# fee in base on buys, starting base and quote balance. client2-* accounts go to the userdata tables.
ACCOUNTS = [
    ("client1-gate", "gate", "ABC_USDT", "gate", 150, 120.0, False, 400_000.0, 60_000.0),
    ("client1-gate", "gate", "XYZ_USDT", "gate", 100, 300.0, False, 30_000.0, 40_000.0),
    ("client1-kucoin", "kucoin", "ABC-USDT", "kucoin", 120, 90.0, False, 250_000.0, 35_000.0),
    ("client1-mexc", "mexc", "ABCUSDT", "mexc", 180, 150.0, True, 500_000.0, 80_000.0),
    ("client1-mexc", "mexc", "XYZUSDT", "mexc", 90, 250.0, True, 25_000.0, 50_000.0),
    ("client2-mexc", "mexc", "ABCUSDT", "c2", 140, 110.0, True, 300_000.0, 45_000.0),
    ("client2-pionex", "pionex", "ABC_USDT", "c2_no_quote", 80, 70.0, False, 150_000.0, 20_000.0),
    ("client2-weex", "weex", "ABCUSDT", "c2", 60, 60.0, False, 120_000.0, 18_000.0),
]


def _wave(t: str, period_ms: int, phase: str = "0") -> str:
    return f"sin(2 * pi() * {t} / {period_ms} + {phase})"


def _mid(t: str) -> str:
    """The market mid price at time `t` (ms) for the bound base, basis and phase."""
    p = "{phase:Float64}"
    return (
        "{base:Float64} * (1 + {basis:Float64}) * exp("
        f"0.05 * {_wave(t, 457_920_000, p)} + 0.025 * {_wave(t, 68_400_000, f'2 * {p}')}"
        f" + 0.01 * {_wave(t, 9_720_000, f'3 * {p}')} + 0.004 * {_wave(t, 1_380_000)}"
        f" + 0.0015 * {_wave(t, 186_000, p)})"
    )


def _rand(*args: str) -> str:
    """A number in [0, 1) that depends only on the arguments."""
    return f"(cityHash64({', '.join(args)}) % 1000000 / 1000000)"


GRID = "{first_ms:Int64} + toInt64(number) * {step_ms:Int64}"

L2_SELECT = f"""
SELECT
    ts AS exchange_ts_ms,
    toInt64(ts + latency) AS receive_ts_ms,
    toUInt64(intDiv(ts, 100)) AS source_sequence,
    false AS bootstrap,
    {{venue:String}} AS venue,
    {{symbol:String}} AS symbol,
    arrayMap(i -> toString(round(best_bid - i * level_px, {{price_dp:UInt8}})), lv) AS bid_prices,
    arrayMap(i -> toString(round({{level_quote:Float64}} * (1 + 0.08 * i)
        * (0.3 + 1.4 * {_rand('ts', '{venue:String}', 'i', "'b'")}) / (best_bid - i * level_px), {{amount_dp:UInt8}})), lv) AS bid_amounts,
    arrayMap(i -> toString(round(best_ask + i * level_px, {{price_dp:UInt8}})), lv) AS ask_prices,
    arrayMap(i -> toString(round({{level_quote:Float64}} * (1 + 0.08 * i)
        * (0.3 + 1.4 * {_rand('ts', '{venue:String}', 'i', "'a'")}) / (best_ask + i * level_px), {{amount_dp:UInt8}})), lv) AS ask_amounts,
    toInt64(latency) AS source_to_receive_ms,
    fromUnixTimestamp64Milli(toInt64(ts + latency + kafka), 'UTC') AS ingested_at,
    toInt64(kafka) AS kafka_to_clickhouse_ms
FROM
(
    SELECT
        {GRID} AS ts,
        {_mid('ts')} AS mid,
        {{spread_bps:Float64}} / 20000 * (0.6 + 0.8 * {_rand('ts', '{venue:String}', "'s'")}) AS half,
        floor(mid * (1 - half) / {{tick:Float64}}) * {{tick:Float64}} AS best_bid,
        greatest(ceil(mid * (1 + half) / {{tick:Float64}}) * {{tick:Float64}}, best_bid + {{tick:Float64}}) AS best_ask,
        {{tick:Float64}} * {{level_gap:UInt32}} AS level_px,
        range({{levels:UInt8}}) AS lv,
        15 + cityHash64(ts, {{venue:String}}, 'l') % 60 AS latency,
        20 + cityHash64(ts, {{venue:String}}, 'k') % 40 AS kafka
    FROM numbers({{n:UInt64}})
)"""

# Columns: t (trade time, ms), trade_id, payload.
TRADES_SELECT = f"""
SELECT
    t,
    trade_id,
    format({{template:String}}, trade_id, order_id, side, if(is_buy, 'true', 'false'), toString(price),
           toString(qty), toString(quote), toString(fee), fee_currency, if(is_maker, 'maker', 'taker'),
           if(is_maker, 'true', 'false'), {{symbol:String}}, upper(side)) AS payload
FROM
(
    SELECT
        t,
        toString(100000000000 + cityHash64({{account:String}}, t) % 900000000000) AS trade_id,
        toString(100000000000 + cityHash64({{account:String}}, t, 'o') % 900000000000) AS order_id,
        {_rand('{account:String}', 'g', "'side'")} < 0.5 + 0.2 * {_wave('g', 146_880_000, '{phase:Float64}')} AS is_buy,
        {_rand('{account:String}', 'g', "'maker'")} < 0.7 AS is_maker,
        if(is_buy, 'buy', 'sell') AS side,
        {_mid('t')} AS mid,
        {{spread_bps:Float64}} / 20000 AS half,
        -- Makers buy at the bid and sell at the ask; takers the other way round.
        round(if(is_buy = is_maker, floor(mid * (1 - half) / {{tick:Float64}}), ceil(mid * (1 + half) / {{tick:Float64}}))
              * {{tick:Float64}}, {{price_dp:UInt8}}) AS price,
        round({{notional:Float64}} * (0.2 + 1.6 * pow({_rand('{account:String}', 'g', "'size'")}, 2)) / price,
              {{amount_dp:UInt8}}) AS qty,
        round(price * qty, 6) AS quote,
        {{fee_in_base:UInt8}} = 1 AND is_buy AS fee_base,
        round(if(fee_base, qty, quote) * if(is_maker, 0.0002, 0.001), 8) AS fee,
        if(fee_base, {{base_asset:String}}, {{quote_asset:String}}) AS fee_currency
    FROM
    (
        SELECT g, g + toInt64(cityHash64({{account:String}}, g, 'dt') % ({{step_ms:Int64}} - 1000)) AS t
        FROM (SELECT {GRID} AS g FROM numbers({{n:UInt64}}))
        WHERE cityHash64({{account:String}}, g, 'p') % 1000 < {{rate:UInt32}}
    )
)"""

# Balance levels: they move in 5-minute steps, base and quote roughly opposite.
BALANCE_LEVELS = f"""
        intDiv(ts, 300000) * 300000 AS step,
        {{base0:Float64}} * (1 + 0.3 * {_wave('step', 285_120_000, '{phase:Float64}')}
                              + 0.08 * {_wave('step', 25_200_000, '2 * {phase:Float64}')}) AS bt,
        {{quote0:Float64}} * (1 - 0.25 * {_wave('step', 285_120_000, '{phase:Float64}')}
                               + 0.05 * {_wave('step', 16_200_000, '3 * {phase:Float64}')}) AS qt,
        0.15 + 0.1 * {_wave('step', 5_400_000, '{phase:Float64}')} AS rf"""

POSITIONS_SELECT = f"""
SELECT
    {{algorithm:String}} AS algorithm_id,
    fromUnixTimestamp64Milli(ts, 'UTC') AS published_at,
    format({{template:String}}, {{algorithm:String}}, {{venue:String}}, {{account:String}}, {{symbol:String}},
           toString(fromUnixTimestamp64Milli(ts - toInt64(cityHash64(ts, {{account:String}}) % 3000), 'UTC')),
           {{base_asset:String}}, toString(round(bt, 2)), toString(round(bt * (1 - rf), 2)), toString(round(bt * rf, 2)),
           {{quote_asset:String}}, toString(round(qt, 2)), toString(round(qt * (1 - rf), 2)), toString(round(qt * rf, 2))
    ) AS payload
FROM (SELECT {GRID} AS ts, {BALANCE_LEVELS} FROM numbers({{n:UInt64}}))"""

# One row per change of one asset: each minute, each asset changes with some probability, and at
# least every hour.
C2_BALANCES_SELECT = f"""
SELECT
    ts AS event_ms,
    concat('b:', asset, ':', toString(ts)) AS dedupe,
    format({{template:String}}, asset, toString(round(total * (1 - rf), 2)), toString(round(total * rf, 2))) AS payload
FROM
(
    SELECT ts, asset, rf, if(asset = {{base_asset:String}}, bt, qt) AS total
    FROM (SELECT {GRID} AS ts, {BALANCE_LEVELS} FROM numbers({{n:UInt64}}))
    ARRAY JOIN [{{base_asset:String}}, {{quote_asset:String}}] AS asset
    WHERE cityHash64(ts, asset, {{account:String}}) % 1000 < 350 OR ts % 3600000 = 0
)"""

INSERTS = {
    "l2": "INSERT INTO trading.l2_snapshots (exchange_ts_ms, receive_ts_ms, source_sequence, bootstrap, venue,"
          " symbol, bid_prices, bid_amounts, ask_prices, ask_amounts, source_to_receive_ms, ingested_at,"
          " kafka_to_clickhouse_ms)" + L2_SELECT,
    "activity": "INSERT INTO trading.account_activity (`schema`, venue, account, symbol, kind, venue_id,"
                " event_time_ms, observed_ms, payload) SELECT 'demo', {venue:String}, {account:String},"
                " {symbol:String}, 'trade', trade_id, t, t + 30, payload FROM (" + TRADES_SELECT + ")",
    "c2_trades": "INSERT INTO userdata.c2_trades (`schema`, venue, account, kind, event_ms, dedupe, payload)"
                 " SELECT 'demo', {venue:String}, {account:String}, 'trade', t, concat('t:', trade_id), payload"
                 " FROM (" + TRADES_SELECT + ")",
    "positions": "INSERT INTO state.position_snapshots (algorithm_id, published_at, payload)" + POSITIONS_SELECT,
    "c2_balances": "INSERT INTO userdata.c2_balances (`schema`, venue, account, kind, event_ms, dedupe, payload)"
                   " SELECT 'demo', {venue:String}, {account:String}, 'balance', event_ms, dedupe, payload"
                   " FROM (" + C2_BALANCES_SELECT + ")",
}


def grid(start_ms: int, end_ms: int, step_ms: int) -> dict[str, int]:
    """The first multiple of step_ms at or after start_ms, and how many fit before end_ms."""
    first = -(-start_ms // step_ms) * step_ms
    return {"first_ms": first, "step_ms": step_ms, "n": max(0, (end_ms - first + step_ms - 1) // step_ms)}


def market_params(venue: str, symbol: str) -> dict[str, Any]:
    _, _, asset, spread_bps, basis = next(m for m in MARKETS if m[0] == venue and m[1] == symbol)
    a = ASSETS[asset]
    return {
        "venue": venue, "symbol": symbol, "base_asset": asset, "quote_asset": QUOTE,
        "spread_bps": spread_bps, "basis": basis, "base": a["base"], "phase": a["phase"], "tick": a["tick"],
        "price_dp": a["price_dp"], "amount_dp": a["amount_dp"], "level_gap": a["level_gap"],
        "level_quote": a["level_quote"],
    }


def statements(start_ms: int, end_ms: int) -> list[tuple[str, dict[str, Any]]]:
    """The inserts that fill [start_ms, end_ms)."""
    out = []
    l2 = grid(start_ms, end_ms, L2_STEP_MS)
    for venue, symbol, *_ in MARKETS:
        out.append((INSERTS["l2"], {**market_params(venue, symbol), **l2, "levels": 20}))

    trades = grid(start_ms, end_ms, TRADE_STEP_MS)
    balances = grid(start_ms, end_ms, BALANCE_STEP_MS)
    for i, (account, venue, symbol, template, rate, notional, fee_in_base, base0, quote0) in enumerate(ACCOUNTS):
        market = market_params(venue, symbol)
        userdata = account.startswith("client2-")
        out.append((INSERTS["c2_trades" if userdata else "activity"], {
            **market, **trades, "account": account, "template": TRADE_TEMPLATES[template],
            "rate": rate, "notional": notional, "fee_in_base": int(fee_in_base),
        }))
        balance = {**market, **balances, "account": account, "base0": base0, "quote0": quote0, "phase": 0.9 * i}
        if userdata:
            out.append((INSERTS["c2_balances"], {**balance, "template": C2_BALANCE_TEMPLATE}))
        else:
            out.append((INSERTS["positions"], {
                **balance, "template": POSITION_TEMPLATE, "algorithm": f"mm-{venue}-{symbol.lower()}",
            }))
    return [(sql, params) for sql, params in out if params["n"] > 0]


def fill(client: Any, start_ms: int, end_ms: int) -> None:
    for sql, params in statements(start_ms, end_ms):
        client.command(sql, parameters=params)
    client.command("INSERT INTO demo.seeded (end_ms) VALUES ({end_ms:Int64})", parameters={"end_ms": end_ms})


# The rows a fill from start_ms on writes, by the grid time they were generated for. Trade times
# are their grid step plus less than one step, so the step is recovered by rounding down.
FILLED_FROM = {
    "trading.l2_snapshots": "exchange_ts_ms >= {start_ms:Int64}",
    "trading.account_activity": f"intDiv(event_time_ms, {TRADE_STEP_MS}) * {TRADE_STEP_MS} >= {{start_ms:Int64}}",
    "userdata.c2_trades": f"intDiv(event_ms, {TRADE_STEP_MS}) * {TRADE_STEP_MS} >= {{start_ms:Int64}}",
    "state.position_snapshots": "published_at >= fromUnixTimestamp64Milli({start_ms:Int64}, 'UTC')",
    "userdata.c2_balances": "event_ms >= {start_ms:Int64}",
}


def clear_from(client: Any, start_ms: int) -> None:
    """Delete what an interrupted fill from start_ms on may have written, so filling the window
    again doesn't duplicate rows (l2_snapshots and position_snapshots are plain MergeTrees)."""
    for table, condition in FILLED_FROM.items():
        client.command(f"DELETE FROM {table} WHERE {condition}", parameters={"start_ms": start_ms})


def create_schema(client: Any) -> None:
    text = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    for statement in "\n".join(lines).split(";\n"):
        if statement.strip():
            client.command(statement)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--follow", action="store_true", help=f"keep adding data every {FOLLOW_SECONDS} s")
    args = parser.parse_args()

    client = get_client()
    create_schema(client)
    now = now_ms()
    seeded = client.query("SELECT max(end_ms) FROM demo.seeded").result_rows[0][0] or 0
    start = max(seeded, now - int(DAYS * 86_400_000))
    t0 = time.monotonic()
    clear_from(client, start)  # in case the last run stopped in the middle of a fill
    fill(client, start, now)
    hours = (now - start) / 3_600_000
    span = f"{hours:.1f} h" if hours >= 1 else f"{hours * 60:.0f} min"
    print(f"Generated {span} of data in {time.monotonic() - t0:.1f} s.", flush=True)
    READY_FILE.touch()

    failed = False
    while args.follow:
        time.sleep(FOLLOW_SECONDS)
        try:  # keep following through a ClickHouse restart
            if failed:
                clear_from(client, now)
                failed = False
            end = now_ms()
            fill(client, now, end)
            now = end
        except Exception as e:
            failed = True
            print(f"Seeding failed, retrying: {e}", flush=True)


if __name__ == "__main__":
    main()
