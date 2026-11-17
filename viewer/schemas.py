"""Request and response models of the viewer API (app.py).

Times are epoch milliseconds (UTC) and a period is half-open: start <= t < end.
Bucket rows are arrays, not objects, to keep responses small; their layout is in each type.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, model_validator

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


# ---- requests (query parameters) ----

MAX_ACCOUNTS = 20


class PeriodQuery(BaseModel):
    start: int = Field(description="Period start, epoch ms (inclusive)")
    end: int = Field(description="Period end, epoch ms (exclusive)")

    @model_validator(mode="after")
    def _check_period(self) -> PeriodQuery:
        if self.start >= self.end:
            raise ValueError("start must be before end")
        return self


class MarketQuery(PeriodQuery):
    venue: NonEmpty
    symbol: NonEmpty


class AccountQuery(PeriodQuery):
    account: list[NonEmpty] = Field(
        min_length=1, max_length=MAX_ACCOUNTS,
        description="venue:account, repeated for several accounts",
    )
    symbol: NonEmpty = Field(description="Pair in any venue's format (ABCUSDT, ABC_USDT, ABC-USDT); "
                                         "each account's venue symbol for it is used")

    @model_validator(mode="after")
    def _check_accounts(self) -> AccountQuery:
        for value in self.account:
            venue, _, account = value.partition(":")
            if not venue.strip() or not account.strip():
                raise ValueError(f"account must be venue:account, not {value!r}")
        return self

    @property
    def accounts(self) -> list[tuple[str, str]]:
        """The (venue, account) pairs, in request order without repeats."""
        pairs = (tuple(part.strip() for part in value.partition(":")[::2]) for value in self.account)
        return list(dict.fromkeys(pairs))


# ---- responses ----

class VenueOptions(BaseModel):
    symbols: list[str]
    accounts: dict[str, list[str]] = Field(description="Account -> symbols it traded")


class Snapshot(BaseModel):
    exchange_ts_ms: int
    receive_ts_ms: int
    bid_prices: list[str] = Field(description="Best (highest) first")
    bid_amounts: list[str]
    ask_prices: list[str]
    ask_amounts: list[str]


class OrderbookResponse(BaseModel):
    snapshot: Snapshot | None = Field(description="The last snapshot in the period, by receive time")


# [start_ms, sum1, sum2, sum3, count]: sums of the snapshots in the bucket, so buckets can be combined.
MarketBucket = tuple[int, float | None, float | None, float | None, int]


class MarketBucketsResponse(BaseModel):
    bucket_ms: int
    buckets: list[MarketBucket]


class Balance(BaseModel):
    observed_ms: int = Field(description="When the venue account was observed")
    base_asset: str
    quote_asset: str
    base_total: float | None
    base_available: float | None
    base_reserved: float | None
    quote_total: float | None
    quote_available: float | None
    quote_reserved: float | None


# [start_ms, base_total, base_available, base_reserved, quote_total, quote_available,
# quote_reserved]: the latest values in the bucket, None when not reported.
BalanceBucket = tuple[int, float | None, float | None, float | None, float | None, float | None, float | None]


class AccountBalance(BaseModel):
    venue: str
    account: str
    latest: Balance | None = Field(description="The latest balance in the period")
    buckets: list[BalanceBucket]


class BalanceResponse(BaseModel):
    bucket_ms: int
    accounts: list[AccountBalance] = Field(description="In request order")


class Trade(BaseModel):
    venue: str
    account: str
    time_ms: int
    side: str | None = Field(description='"buy" or "sell"')
    price: float | None
    amount: float | None
    quote: float | None
    fee: float | None
    fee_currency: str | None
    role: str | None = Field(description='"maker" or "taker"')
    order_id: str | None
    trade_id: str | None


class TradeSummary(BaseModel):
    count: int
    fees: dict[str, float] = Field(description="Fee currency -> total fee")
    buy_count: int
    buy_amount: float
    buy_quote: float
    sell_count: int
    sell_amount: float
    sell_quote: float
    last_price: float | None = Field(description="Price of the newest trade")


# [start_ms, sell_quote, buy_quote, trade count, sell_amount, buy_amount, last_price, *fees]:
# last_price is the price of the bucket's newest trade (null if none has one); fees has one
# total per currency of the account's fee_currencies, in that order.
TradeBucket = list[float | int | None]


class AccountTrades(BaseModel):
    venue: str
    account: str
    summary: TradeSummary = Field(description="Over the account's trades in the period")
    fee_currencies: list[str] = Field(description="The fee columns at the end of each bucket")
    buckets: list[TradeBucket]


class TradesResponse(BaseModel):
    trades: list[Trade] = Field(description="The newest `limit` trades of all accounts, newest first")
    total: int = Field(description="Trades in the period, all accounts")
    limit: int
    summary: TradeSummary = Field(description="Over all trades of all accounts in the period")
    base: str | None = Field(description="Base asset of the pair, null if it can't be told")
    quote: str | None = Field(description="Quote asset of the pair")
    bucket_ms: int
    accounts: list[AccountTrades] = Field(description="In request order")
