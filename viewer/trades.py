"""Map venue-specific trade payloads (account_activity.payload) and userdata.c2_trades rows to
common fields."""

from __future__ import annotations

from typing import Any

# For each field, the payload keys that hold it on some venue, tried in order.
# Covers gate, kucoin, mexc, pionex and weex trade messages.
TRADE_FIELDS: dict[str, tuple[str, ...]] = {
    "side": ("side", "isBuyer"),
    "price": ("price",),
    "amount": ("amount", "size", "qty"),
    "quote": ("deal", "funds", "quoteQty"),
    "fee": ("fee", "commission"),
    "fee_currency": ("fee_currency", "feeCurrency", "commissionAsset", "feeCoin"),
    "role": ("role", "liquidity", "isMaker"),
    "order_id": ("order_id", "orderId"),
    "trade_id": ("tradeId", "id"),
}
NUMERIC_FIELDS = ("price", "amount", "quote", "fee")
ID_FIELDS = ("order_id", "trade_id")


def _first(payload: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if payload.get(key) not in (None, ""):
            return payload[key]
    return None


def normalize_trade(payload: dict[str, Any]) -> dict[str, Any]:
    """Return side ("buy"/"sell"), role ("maker"/"taker"), float price/amount/quote/fee and
    string ids (venue ids can exceed the JavaScript safe integer range). Missing fields are None."""
    trade = {name: _first(payload, keys) for name, keys in TRADE_FIELDS.items()}

    # mexc/weex flag the side and role with booleans instead of strings.
    if isinstance(trade["side"], bool):
        trade["side"] = "buy" if trade["side"] else "sell"
    if isinstance(trade["role"], bool):
        trade["role"] = "maker" if trade["role"] else "taker"
    for name in ("side", "role"):
        if isinstance(trade[name], str):
            trade[name] = trade[name].lower()

    for name in NUMERIC_FIELDS:
        if trade[name] is not None:
            trade[name] = float(trade[name])
    if trade["quote"] is None and trade["price"] is not None and trade["amount"] is not None:
        trade["quote"] = trade["price"] * trade["amount"]

    for name in ID_FIELDS:
        if trade[name] is not None:
            trade[name] = str(trade[name])
    return trade


def normalize_c2_trade(row: dict[str, Any]) -> dict[str, Any]:
    """The same fields as normalize_trade for a query.build_c2_trades_query row, whose columns are
    already normalized across venues."""
    price, amount = row["price"], row["qty"]
    maker = row["maker"]
    return {
        "side": row["side"].lower() or None,
        "price": price,
        "amount": amount,
        # quote_qty is 0 where the venue doesn't report it (pionex).
        "quote": row["quote_qty"] or price * amount,
        "fee": row["fee"],
        "fee_currency": row["fee_asset"],
        "role": None if maker is None else "maker" if maker else "taker",
        "order_id": row["order_id"] or None,
        "trade_id": row["trade_id"] or None,
    }


def summarize(trades: list[dict[str, Any]]) -> dict[str, Any]:
    """Counts, amounts and quote volumes per side, fees per currency, and the price of the newest
    trade (by time_ms), for normalized trades."""
    newest = max(trades, key=lambda t: t["time_ms"], default=None)
    summary: dict[str, Any] = {"count": len(trades), "fees": {}, "last_price": newest and newest["price"]}
    for side in ("buy", "sell"):
        summary.update({f"{side}_count": 0, f"{side}_amount": 0.0, f"{side}_quote": 0.0})

    for t in trades:
        if t["side"] in ("buy", "sell"):
            summary[f"{t['side']}_count"] += 1
            summary[f"{t['side']}_amount"] += t["amount"] or 0.0
            summary[f"{t['side']}_quote"] += t["quote"] or 0.0
        if t["fee"]:
            currency = t["fee_currency"] or "?"
            summary["fees"][currency] = summary["fees"].get(currency, 0.0) + t["fee"]
    return summary


def quote_buckets(trades: list[dict[str, Any]], bucket_ms: int, fee_currencies: list[str]) -> list[list[Any]]:
    """Per time bucket, ascending: [start_ms, sell_quote, buy_quote, count, sell_amount,
    buy_amount, last_price, *fees], where last_price is the price of the bucket's newest trade
    (None if no trade has one) and fees has the bucket's fee total for each of fee_currencies.

    Buckets start at multiples of bucket_ms since the epoch (UTC-aligned); empty ones are left out.
    Trades need a "time_ms" key.
    """
    fee_index = {currency: 7 + i for i, currency in enumerate(fee_currencies)}
    buckets: dict[int, list[Any]] = {}
    newest: dict[int, int] = {}  # bucket start -> time_ms of the trade its last_price is from
    for t in trades:
        start = t["time_ms"] // bucket_ms * bucket_ms
        bucket = buckets.setdefault(start, [start, 0.0, 0.0, 0, 0.0, 0.0, None, *(0.0 for _ in fee_currencies)])
        if t["side"] == "sell":
            bucket[1] += t["quote"] or 0.0
            bucket[4] += t["amount"] or 0.0
        elif t["side"] == "buy":
            bucket[2] += t["quote"] or 0.0
            bucket[5] += t["amount"] or 0.0
        bucket[3] += 1
        if t["price"] is not None and t["time_ms"] >= newest.get(start, t["time_ms"]):
            newest[start] = t["time_ms"]
            bucket[6] = t["price"]
        if t["fee"]:
            bucket[fee_index[t["fee_currency"] or "?"]] += t["fee"]
    return [buckets[start] for start in sorted(buckets)]
