-- Demo schema: the tables and views viewer/query.py reads, with the same names and the columns it
-- uses. Production tables have more columns and settings; this is enough for the viewer.
-- Run by demo/seed.py (statements are split on ";" at line ends).

CREATE DATABASE IF NOT EXISTS trading;
CREATE DATABASE IF NOT EXISTS observability;
CREATE DATABASE IF NOT EXISTS state;
CREATE DATABASE IF NOT EXISTS userdata;
CREATE DATABASE IF NOT EXISTS demo;

-- L2 order book snapshots. Prices and amounts are strings, bids best (highest) first.
CREATE TABLE IF NOT EXISTS trading.l2_snapshots
(
    exchange_ts_ms Int64,
    receive_ts_ms Int64,
    source_sequence UInt64,
    bootstrap Bool,
    venue LowCardinality(String),
    symbol LowCardinality(String),
    bid_prices Array(String),
    bid_amounts Array(String),
    ask_prices Array(String),
    ask_amounts Array(String),
    source_to_receive_ms Int64,
    ingested_at DateTime64(3, 'UTC'),
    kafka_to_clickhouse_ms Int64,
    bid_prices_decimal Array(Decimal(38, 18)) DEFAULT arrayMap(x -> toDecimal128OrZero(x, 18), bid_prices),
    bid_amounts_decimal Array(Decimal(38, 18)) DEFAULT arrayMap(x -> toDecimal128OrZero(x, 18), bid_amounts),
    ask_prices_decimal Array(Decimal(38, 18)) DEFAULT arrayMap(x -> toDecimal128OrZero(x, 18), ask_prices),
    ask_amounts_decimal Array(Decimal(38, 18)) DEFAULT arrayMap(x -> toDecimal128OrZero(x, 18), ask_amounts)
)
ENGINE = MergeTree
ORDER BY (symbol, receive_ts_ms, source_sequence);

-- Orders and trades with the venue's raw JSON message in payload.
CREATE TABLE IF NOT EXISTS trading.account_activity
(
    `schema` LowCardinality(String),
    venue LowCardinality(String),
    account String,
    symbol String,
    kind LowCardinality(String),
    venue_id String,
    event_time_ms Int64,
    observed_ms Int64,
    payload String
)
ENGINE = ReplacingMergeTree
ORDER BY (venue, account, symbol, kind, venue_id);

-- Per snapshot: spread percent and the quote value of the levels within 2% of mid.
CREATE VIEW IF NOT EXISTS observability.mm_market_depth AS
SELECT
    'trading' AS native_database,
    fromUnixTimestamp64Milli(receive_ts_ms, 'UTC') AS observed_at,
    venue,
    symbol,
    (best_ask - best_bid) / mid * 100 AS spread_percent,
    arraySum(arrayMap((p, a) -> if(p >= mid * 0.98, p * a, 0), bp, bq)) AS bid_depth_2pct_quote,
    arraySum(arrayMap((p, a) -> if(p <= mid * 1.02, p * a, 0), ap, aq)) AS ask_depth_2pct_quote
FROM
(
    SELECT
        receive_ts_ms,
        venue,
        symbol,
        arrayMap(x -> toFloat64(x), bid_prices) AS bp,
        arrayMap(x -> toFloat64(x), bid_amounts) AS bq,
        arrayMap(x -> toFloat64(x), ask_prices) AS ap,
        arrayMap(x -> toFloat64(x), ask_amounts) AS aq,
        bp[1] AS best_bid,
        ap[1] AS best_ask,
        (best_bid + best_ask) / 2 AS mid
    FROM trading.l2_snapshots
    WHERE notEmpty(bid_prices) AND notEmpty(ask_prices)
);

-- Per snapshot: best bid, best ask and mid.
CREATE VIEW IF NOT EXISTS observability.mm_market_mid AS
SELECT
    'trading' AS native_database,
    fromUnixTimestamp64Milli(receive_ts_ms, 'UTC') AS observed_at,
    receive_ts_ms,
    venue,
    symbol,
    toFloat64(bid_prices[1]) AS best_bid,
    toFloat64(ask_prices[1]) AS best_ask,
    (best_bid + best_ask) / 2 AS mid_price
FROM trading.l2_snapshots
WHERE notEmpty(bid_prices) AND notEmpty(ask_prices);

-- Balances published by the trading algorithms: one JSON payload per algorithm and publish,
-- with position.venues[] entries (venue, accountId, symbol, observedAt, base/quote balances).
CREATE TABLE IF NOT EXISTS state.position_snapshots
(
    algorithm_id String,
    published_at DateTime64(3, 'UTC'),
    payload String
)
ENGINE = MergeTree
ORDER BY (algorithm_id, published_at);

-- Trades of client2-* accounts, with typed columns materialized from the payload.
CREATE TABLE IF NOT EXISTS userdata.c2_trades
(
    `schema` LowCardinality(String),
    venue LowCardinality(String),
    account String,
    kind LowCardinality(String),
    event_ms Int64,
    dedupe String,
    payload String,
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    symbol String MATERIALIZED JSONExtractString(payload, 'symbol'),
    trade_id String MATERIALIZED JSONExtractString(payload, 'trade_id'),
    order_id String MATERIALIZED JSONExtractString(payload, 'order_id'),
    client_order_id String MATERIALIZED JSONExtractString(payload, 'client_order_id'),
    side LowCardinality(String) MATERIALIZED JSONExtractString(payload, 'side'),
    price Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'price')),
    qty Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'qty')),
    quote_qty Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'quote_qty')),
    maker UInt8 MATERIALIZED JSONExtractBool(payload, 'maker'),
    fee Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'fee')),
    fee_asset LowCardinality(String) MATERIALIZED JSONExtractString(payload, 'fee_asset'),
    src LowCardinality(String) MATERIALIZED JSONExtractString(payload, 'src')
)
ENGINE = ReplacingMergeTree
ORDER BY (venue, event_ms, dedupe);

-- Balance changes of client2-* accounts: one row per change of one asset.
CREATE TABLE IF NOT EXISTS userdata.c2_balances
(
    `schema` LowCardinality(String),
    venue LowCardinality(String),
    account String,
    kind LowCardinality(String),
    event_ms Int64,
    dedupe String,
    payload String,
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    asset LowCardinality(String) MATERIALIZED JSONExtractString(payload, 'asset'),
    free Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'free')),
    locked Float64 MATERIALIZED toFloat64OrZero(JSONExtractString(payload, 'locked')),
    src LowCardinality(String) MATERIALIZED JSONExtractString(payload, 'src')
)
ENGINE = ReplacingMergeTree
ORDER BY (venue, event_ms, dedupe);

-- How far the generator has filled the tables (the end of the last window, epoch ms).
CREATE TABLE IF NOT EXISTS demo.seeded
(
    end_ms Int64
)
ENGINE = MergeTree
ORDER BY tuple();
