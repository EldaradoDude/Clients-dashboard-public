// Overview page blocks, all as stat tiles that stretch across the panel:
// - market: per exchange of the selected accounts, the top of the last order book snapshot at or
//   before the period end (a row of tiles per exchange when there are several);
// - balances: the combined latest base and quote totals of the selected accounts, then per
//   exchange when they are on several;
// - trades: the combined stats of all selected accounts.

import { assetName, combinedLatest, missingNote, SIDES } from "./balance.js";
import { esc, message, stat } from "./dom.js";
import { fmtAge, num, splitFees } from "./format.js";
import { topOfBook } from "./orderbook.js";
import { tradeFigures } from "./trades.js";

// 4 significant digits, thousands as K, millions as M, billions as B (-101,029.99 -> -101K,
// 11,546.11 -> 11.55K, 0.11428399 -> 0.1143). The full number is in the tooltip.
const short = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 });
const shortNum = x => x == null ? "–" : `<span title="${num(x)}">${short.format(x)}</span>`;

const tiles = html => `<div class="stats ov-stats">${html}</div>`;

// A named row of tiles, used when a block has several (per exchange, per asset).
const namedRow = (name, html) => `<div class="ov-row"><div class="ov-row-name">${name}</div>${tiles(html)}</div>`;

// A titled block of the overview panel, filled later through its `id`.
export const block = (title, sub, id) => `
  <div class="ov-block">
    <div class="ov-head"><b>${esc(title)}</b> <span class="muted">${esc(sub)}</span></div>
    <div class="ov-body" id="${id}"><div class="message">Loading…</div></div>
  </div>`;

// ---- market ----

// `rows` are { venue, symbol, snapshot } (snapshot from /api/orderbook, may be null); `end` is the
// period end in epoch ms.
export function renderMarket(rows, end) {
  const markets = rows.map(({ venue, symbol, snapshot }) => {
    const ok = snapshot?.bid_prices.length && snapshot.ask_prices.length;
    return { venue, symbol, top: ok ? topOfBook(snapshot.bid_prices, snapshot.ask_prices) : null,
             age: snapshot ? fmtAge(end - snapshot.receive_ts_ms) : null };
  });
  if (!markets.some(m => m.top)) return message("No order book snapshot in this period.");

  const marketTiles = ({ top, age }) => top
    ? stat("Spread %", `${top.percent}%`) +
      stat("Spread bps", top.bps) +
      stat("Best bid", `<span class="buy">${esc(top.bid)}</span>`) +
      stat("Best ask", `<span class="sell">${esc(top.ask)}</span>`) +
      stat("Mid", top.mid) +
      stat("Snapshot age", age)
    : `<div class="muted">No snapshot in this period</div>`;
  if (markets.length === 1) return tiles(marketTiles(markets[0]));
  return markets.map(m =>
    namedRow(`${esc(m.venue)} <span class="muted">${esc(m.symbol)}</span>`, marketTiles(m))).join("");
}

// ---- balances ----

// `data` is the /api/balance result: the sum of the accounts' latest totals per asset, and the
// same per exchange.
export function renderBalanceTiles({ accounts }) {
  if (!accounts.some(a => a.latest)) return message("No balance observations in this period.");
  const names = Object.fromEntries(SIDES.map(side => [side, assetName(accounts, side)]));
  const totals = group => {
    const combined = combinedLatest(group);
    return SIDES.map(side => stat(`${names[side]} total`, shortNum(combined[`${side}_total`]))).join("");
  };
  const venues = [...new Set(accounts.filter(a => a.latest).map(a => a.venue))];
  const perVenue = venues.length > 1
    ? venues.map(venue => namedRow(esc(venue), totals(accounts.filter(a => a.venue === venue && a.latest)))).join("")
    : "";
  return namedRow(venues.length > 1 ? "All exchanges" : esc(venues[0]), totals(accounts)) + perVenue +
    missingNote(accounts, names);
}

// ---- trades ----

// The combined trade stats; `data` is the /api/trades result. Fees are split into the pair's
// quote and base currency (format.splitFees); a fee in any other currency gets its own tile.
export function renderTradeStats({ total, summary, base, quote }) {
  if (!total) return message("No trades in this period.");
  const f = tradeFigures(summary);
  const fees = splitFees(summary.fees, base, quote);
  return tiles(
    stat("Net amount", shortNum(f.netAmount)) +
    stat("Net quote", shortNum(f.netQuote)) +
    stat("Position price", shortNum(f.positionPrice)) +
    stat("PnL", shortNum(f.pnl)) +
    stat("Fees quote", shortNum(fees.quote)) +
    stat("Fees base", shortNum(fees.base)) +
    Object.entries(fees.other).map(([currency, fee]) => stat(`Fees ${currency}`,shortNum(fee))).join(""));
}
