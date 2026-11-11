// Trades panel: summary stats, the trade delta chart and a collapsible trades table. With several
// accounts the stats are a table with a row per account and a combined row, the chart shows one
// account at a time, and the trades table has an account column.

import { initDeltaChart } from "./delta-chart.js";
import { esc, message, stat } from "./dom.js";
import { accountName, fmtTime, getTimeZone, num, splitFees } from "./format.js";
import { gotoTools } from "./table-goto.js";

// The figures of a server summary (TradeSummary): net amount and quote; the price the net
// amount was acquired at (sold at, when negative), null without one; and the PnL, the net amount
// valued at the last trade price plus the quote it cost, null without a last price.
export function tradeFigures(s) {
  const netAmount = s.buy_amount - s.sell_amount;
  const netQuote = s.sell_quote - s.buy_quote;
  return {
    netAmount,
    netQuote,
    positionPrice: netAmount ? -netQuote / netAmount : null,
    pnl: s.last_price == null ? null : netAmount * s.last_price + netQuote,
  };
}

// [label, value HTML] pairs for a server summary (TradeSummary). `assets` is { base, quote }
// (names, may be null); `otherFees` lists the fee currencies besides those two that get a field.
function summaryFields(s, assets, otherFees) {
  const f = tradeFigures(s);
  const fees = splitFees(s.fees, assets.base, assets.quote);
  return [
    // Sums of many floats: 6 decimals hides the rounding noise.
    ["Net amount", num(f.netAmount, 6)],
    ["Net quote", num(f.netQuote, 4)],
    ["Position price", f.positionPrice == null ? "–" : num(f.positionPrice)],
    ["PnL", f.pnl == null ? "–" : num(f.pnl, 4)],
    ["Fees quote", num(fees.quote, 6)],
    ["Fees base", num(fees.base, 6)],
    ...otherFees.map(currency => [`Fees ${currency}`, num(fees.other[currency] ?? 0, 6)]),
  ];
}

// The fee currencies of a combined summary other than the pair's base and quote.
const otherFeeCurrencies = (s, assets) => Object.keys(splitFees(s.fees, assets.base, assets.quote).other).sort();

const summaryStats = (s, assets) =>
  `<div class="stats">${summaryFields(s, assets, otherFeeCurrencies(s, assets))
    .map(([label, value]) => stat(label, value)).join("")}</div>`;

// A row per account, then the combined summary over all of them.
function summaryTable(accounts, combined, assets) {
  const otherFees = otherFeeCurrencies(combined, assets);
  const row = (name, s, cls = "") =>
    `<tr class="${cls}"><td>${name}</td>${summaryFields(s, assets, otherFees).map(([, value]) => `<td>${value}</td>`).join("")}</tr>`;
  const head = summaryFields(combined, assets, otherFees).map(([label]) => `<th>${esc(label)}</th>`).join("");
  return `
    <div class="scroll-x">
      <table class="summary">
        <thead><tr><th>Account</th>${head}</tr></thead>
        <tbody>
          ${accounts.map(a => row(esc(accountName(a.venue, a.account)), a.summary)).join("")}
          ${row("Combined", combined, "total")}
        </tbody>
      </table>
    </div>`;
}

// The chart itself is drawn by initTradesChart() once this is in the page.
function chartBlock(accounts) {
  const accountSelect = accounts.length > 1
    ? `<label class="inline">Account <select class="account">${
        accounts.map((a, i) => `<option value="${i}">${esc(accountName(a.venue, a.account))}</option>`).join("")}</select></label>`
    : "";
  return `
    <div class="chart-block" id="delta">
      <div class="chart-head">
        <div class="chart-title"><b>Trade delta</b> <span class="muted">sell quote − buy quote per bar</span></div>
        <div class="chart-key">
          <i class="swatch swatch-sell"></i>net sell
          <i class="swatch swatch-buy"></i>net buy
        </div>
        ${accountSelect}
        <label class="inline">Interval <select class="interval"></select></label>
      </div>
      <div class="chart"></div>
    </div>`;
}

function tradeRow(t, withAccount) {
  return `
    <tr data-t="${t.time_ms}">
      <td>${fmtTime(t.time_ms)}</td>
      ${withAccount ? `<td>${esc(accountName(t.venue, t.account))}</td>` : ""}
      <td class="${esc(t.side)}">${esc(t.side)}</td>
      <td>${num(t.price, 10)}</td>
      <td>${num(t.amount)}</td>
      <td>${num(t.quote, 6)}</td>
      <td>${num(t.fee)} <span class="muted">${esc(t.fee_currency)}</span></td>
      <td>${esc(t.role)}</td>
    </tr>`;
}

// Hidden until its summary row is clicked.
function tableToggle(trades, total, withAccount) {
  const truncated = total > trades.length;
  const label = truncated ? `latest ${trades.length} of ${total} trades` : `${total} trades`;
  const note = truncated
    ? `<div class="note">Only the latest ${trades.length} trades are listed; the stats and chart cover all ${total}.</div>`
    : "";
  return `
    <details class="table-toggle">
      <summary>Trades table <span class="muted">${label}</span></summary>
      ${note}
      ${gotoTools()}
      <div class="scroll">
        <table class="trades">
          <thead>
            <tr>
              <th>Time (${esc(getTimeZone())})</th>${withAccount ? "<th>Account</th>" : ""}<th>Side</th><th>Price</th><th>Amount</th>
              <th>Quote</th><th>Fee</th><th>Role</th>
            </tr>
          </thead>
          <tbody>${trades.map(t => tradeRow(t, withAccount)).join("")}</tbody>
        </table>
      </div>
    </details>`;
}

// `data` is the /api/trades result.
export function renderTrades({ trades, total, summary, accounts, base, quote }) {
  if (!total) return message("No trades in this period.");
  const many = accounts.length > 1;
  const assets = { base, quote };
  return (many ? summaryTable(accounts, summary, assets) : summaryStats(summary, assets)) +
    chartBlock(accounts) + tableToggle(trades, total, many);
}

// `block` is the #delta element from renderTrades(); `period` is { start, end } in epoch ms.
// The chart first shows the first account with trades.
export function initTradesChart(block, { accounts, base, quote }, period) {
  const first = Math.max(0, accounts.findIndex(a => a.summary.count));
  const chart = initDeltaChart(block, accounts[first], period, { base, quote });
  const select = block.querySelector("select.account");
  if (!select) return;
  select.value = first;
  select.addEventListener("change", () => chart.show(accounts[select.value]));
}
