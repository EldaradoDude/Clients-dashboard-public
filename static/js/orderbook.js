// Order book panel: stats and a price ladder (asks above, bids below) with depth bars.
// The ladder can group levels to fewer price decimals (summing their amounts and quote values)
// and show both sides, asks only or bids only.

import { esc, message, stat } from "./dom.js";
import { decimals, fmtAge, fmtTime, num } from "./format.js";

const SIDE_KEY = "clickhouse-viewer.book-side";
const DECIMALS_KEY = "clickhouse-viewer.book-decimals";  // { symbol: decimals }
const VISIBLE_ROWS = 20;  // the ladder is as tall as this many levels (10 a side when both)
const MAX_GROUPING = 6;  // at most this many decimals fewer than the prices have

const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "USD", "EUR", "TRY", "BTC", "ETH", "BNB"];

// The quote asset of a symbol such as ABC_USDT, ADA-USDT or XYZUSDT.
function quoteAsset(symbol) {
  const parts = symbol.split(/[-_/]/);
  if (parts.length > 1) return parts.at(-1).toUpperCase();
  return QUOTES.find(q => symbol.toUpperCase().endsWith(q) && symbol.length > q.length) ?? "quote";
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function storeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Levels best first, grouped to `digits` decimals (bids round down, asks up, so a group never
// looks better than its levels), each with its amount, quote value and their running sums.
// At the prices' own precision (`native`) the price strings are shown as sent.
function bookSide(prices, amounts, isBid, digits, native) {
  const scale = 10 ** digits;
  const groups = new Map();
  prices.forEach((p, i) => {
    const price = Number(p), amount = Number(amounts[i]);
    // The small nudge keeps exact multiples (0.125 * 1000 = 124.99999…) in their own group.
    const key = isBid ? Math.floor(price * scale + 1e-6) : Math.ceil(price * scale - 1e-6);
    const g = groups.get(key) ?? { key, amount: 0, quote: 0, raw: p };
    g.amount += amount;
    g.quote += price * amount;
    groups.set(key, g);
  });
  const levels = [...groups.values()].sort((x, y) => isBid ? y.key - x.key : x.key - y.key);
  let cum = 0, cumQuote = 0;
  for (const level of levels) {
    level.price = digits === native ? level.raw : (level.key / scale).toFixed(digits);
    level.cum = cum += level.amount;
    level.cumQuote = cumQuote += level.quote;
  }
  return levels;
}

function ladderRow(level, side, maxCum) {
  const depth = (level.cumQuote / maxCum * 100).toFixed(1);
  return `
    <tr class="${side}" style="--depth: ${depth}%">
      <td>${esc(level.price)}</td>
      <td>${num(level.amount)}</td>
      <td>${num(level.cum)}</td>
      <td class="quote">${num(level.quote, 2)}</td>
      <td class="quote">${num(level.cumQuote, 2)}</td>
    </tr>`;
}

// Best bid and ask (the strings sent), mid, and the spread as percent and bps of mid.
export function topOfBook(bidPrices, askPrices) {
  const bestBid = bidPrices.reduce((a, b) => Number(b) > Number(a) ? b : a);
  const bestAsk = askPrices.reduce((a, b) => Number(b) < Number(a) ? b : a);
  const bid = Number(bestBid), ask = Number(bestAsk);
  const digits = Math.max(decimals(bestBid), decimals(bestAsk));
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  return {
    bid: bestBid,
    ask: bestAsk,
    mid: mid.toFixed(digits + 1),
    percent: (spread / mid * 100).toFixed(3),
    bps: (spread / mid * 1e4).toFixed(1),
  };
}

// `snapshot` is the /api/orderbook result; `end` is the period end in epoch ms. The ladder is
// drawn by initBook() once this is in the page.
export function renderBook({ snapshot }, end) {
  if (!snapshot) return message("No snapshot in this period.");

  let stats =
    stat("Received", fmtTime(snapshot.receive_ts_ms)) +
    stat("Exchange time", fmtTime(snapshot.exchange_ts_ms)) +
    stat("Age at period end", fmtAge(end - snapshot.receive_ts_ms));

  if (snapshot.bid_prices.length && snapshot.ask_prices.length) {
    const top = topOfBook(snapshot.bid_prices, snapshot.ask_prices);
    stats +=
      stat("Best bid", `<span class="buy">${esc(top.bid)}</span>`) +
      stat("Best ask", `<span class="sell">${esc(top.ask)}</span>`) +
      stat("Mid", top.mid) +
      stat("Spread", `${top.percent}% <span class="muted">(${top.bps} bps)</span>`);
  }

  return `
    <div class="stats">${stats}</div>
    <div class="book-head">
      <div class="views">
        <button data-side="both">Asks &amp; bids</button>
        <button data-side="asks">Asks</button>
        <button data-side="bids">Bids</button>
      </div>
      <label class="inline">Decimals <select class="decimals"></select></label>
    </div>
    <div class="scroll book-scroll"></div>`;
}

// Draws the ladder of `snapshot` (the /api/orderbook snapshot) into `container`, the panel
// holding renderBook()'s HTML, and binds its controls. `symbol` names the pair.
export function initBook(container, snapshot, symbol) {
  const scroller = container.querySelector(".book-scroll");
  if (!scroller) return;
  const allPrices = [...snapshot.bid_prices, ...snapshot.ask_prices];
  const native = Math.max(0, ...allPrices.map(decimals));
  const maxPrice = Math.max(...allPrices.map(Number));
  const quote = esc(quoteAsset(symbol));

  // Decimal choices: the prices' own, then fewer, while a step is still below the top price.
  const select = container.querySelector("select.decimals");
  const choices = [];
  for (let d = native; d >= Math.max(0, native - MAX_GROUPING); d--) {
    if (d < native && 10 ** -d > maxPrice) break;
    choices.push(d);
  }
  select.innerHTML = choices.map(d => `<option value="${d}">${d}</option>`).join("");
  const storedDecimals = readJSON(DECIMALS_KEY) ?? {};
  select.value = choices.includes(storedDecimals[symbol]) ? storedDecimals[symbol] : native;

  const buttons = [...container.querySelectorAll(".book-head [data-side]")];
  let side = readJSON(SIDE_KEY);
  if (!["both", "asks", "bids"].includes(side)) side = "both";

  const draw = () => {
    const digits = Number(select.value);
    const bids = bookSide(snapshot.bid_prices, snapshot.bid_amounts, true, digits, native);
    const asks = bookSide(snapshot.ask_prices, snapshot.ask_amounts, false, digits, native);
    const shownBids = side !== "asks" ? bids : [], shownAsks = side !== "bids" ? asks : [];
    const maxCum = Math.max(shownBids.at(-1)?.cumQuote ?? 0, shownAsks.at(-1)?.cumQuote ?? 0) || 1;

    let spreadRow = "";
    if (side === "both" && bids.length && asks.length) {
      const top = topOfBook(snapshot.bid_prices, snapshot.ask_prices);
      spreadRow = `<tr class="spread"><td colspan="5">spread ${top.percent}% · ${top.bps} bps</td></tr>`;
    }
    const askRows = shownAsks.slice().reverse().map(level => ladderRow(level, "ask", maxCum)).join("");
    const bidRows = shownBids.map(level => ladderRow(level, "bid", maxCum)).join("");
    const empty = !askRows && !bidRows ? `<tr><td colspan="5" class="muted">No levels on this side.</td></tr>` : "";

    scroller.innerHTML = `
      <table class="book">
        <thead><tr>
          <th>Price</th><th>Amount</th><th>Total</th>
          <th class="quote">Size ${quote}</th><th class="quote">Total ${quote}</th>
        </tr></thead>
        <tbody>${askRows}${spreadRow}${bidRows}${empty}</tbody>
      </table>`;
    for (const b of buttons) b.setAttribute("aria-pressed", b.dataset.side === side);
    fitAndScroll(scroller, side);
  };

  container.querySelector(".book-head .views").addEventListener("click", e => {
    if (!e.target.dataset.side) return;
    side = e.target.dataset.side;
    storeJSON(SIDE_KEY, side);
    draw();
  });
  select.addEventListener("change", () => {
    storeJSON(DECIMALS_KEY, { ...(readJSON(DECIMALS_KEY) ?? {}), [symbol]: Number(select.value) });
    draw();
  });
  draw();
}

// Size the ladder to VISIBLE_ROWS levels and scroll the best prices into view: the spread in
// the middle, the best ask at the bottom (asks only) or the best bid at the top (bids only).
function fitAndScroll(scroller, side) {
  const head = scroller.querySelector("thead")?.offsetHeight ?? 0;
  const row = scroller.querySelector("tbody tr.ask, tbody tr.bid")?.offsetHeight ?? 28;
  const spread = scroller.querySelector("tr.spread");
  scroller.style.maxHeight = `${head + VISIBLE_ROWS * row + (spread?.offsetHeight ?? 0) + 2}px`;
  if (spread) scroller.scrollTop = spread.offsetTop - (scroller.clientHeight - spread.offsetHeight) / 2;
  else scroller.scrollTop = side === "asks" ? scroller.scrollHeight : 0;
}
