// Trade delta bar chart: per interval, the sum of sell quotes minus the sum of buy quotes.
// Net selling goes up in the sell colour, net buying goes down in the buy colour. The tooltip
// has the interval's figures, computed like the trades summary but from its trades only.
//
// Input is the server's 1-minute buckets ([start_ms, sell_quote, buy_quote, count, sell_amount,
// buy_amount, last_price, ...fees per the account's fee_currencies]).

import { fmtMinute, initBarChart } from "./bar-chart.js";
import { esc } from "./dom.js";
import { num, splitFees } from "./format.js";

const LAST_PRICE = 5;  // index of last_price in the bucket values (after start_ms)

const row = (label, value, unit = "") =>
  `<div class="tip-row"><span>${label}</span><span>${value}${unit ? ` <span class="muted">${esc(unit)}</span>` : ""}</span></div>`;

function tooltipHtml(bar, interval, { base, quote }) {
  const side = bar.delta > 0 ? "net sell" : bar.delta < 0 ? "net buy" : "flat";
  const swatch = bar.delta > 0 ? "swatch-sell" : bar.delta < 0 ? "swatch-buy" : "";
  const netAmount = bar.buyAmount - bar.sellAmount;
  const netQuote = bar.delta;
  const fees = splitFees(Object.fromEntries(bar.fees), base, quote);
  const otherFees = Object.entries(fees.other).filter(([, fee]) => fee)
    .map(([currency, fee]) => row(`Fees ${esc(currency)}`, num(fee, 6))).join("");
  return `
    <div class="tip-time">${fmtMinute(bar.t)} → ${fmtMinute(bar.t + interval)}</div>
    <div class="tip-row"><span><i class="swatch ${swatch}"></i>Net quote (delta)</span><b>${num(netQuote, 4)}</b></div>
    <div class="tip-row muted"><span></span><span>${side}</span></div>
    ${row("Sell quote", num(bar.sell, 4), quote)}
    ${row("Buy quote", num(bar.buy, 4), quote)}
    ${row("Sell base", num(bar.sellAmount, 6), base)}
    ${row("Buy base", num(bar.buyAmount, 6), base)}
    ${row("Net amount", num(netAmount, 6), base)}
    ${row("Position price", netAmount ? num(-netQuote / netAmount) : "–")}
    ${row("PnL", bar.lastPrice == null ? "–" : num(netAmount * bar.lastPrice + netQuote, 4), quote)}
    ${row("Fees quote", num(fees.quote, 6), quote)}
    ${row("Fees base", num(fees.base, 6), base)}
    ${otherFees}
    ${row("Trades", bar.count)}`;
}

// `block` holds an interval <select> and a `.chart` element; `account` is an /api/trades account
// ({ buckets, fee_currencies }); `period` is { start, end } in epoch ms; `assets` is { base, quote }
// (names, may be null). Returns { show(account) }, which redraws the chart for another account.
export function initDeltaChart(block, account, period, assets) {
  let feeCurrencies = account.fee_currencies;
  const names = { base: assets.base ?? "base", quote: assets.quote ?? "quote" };
  const chart = initBarChart(block.querySelector(".interval"), block.querySelector(".chart"), account.buckets, period, {
    storeKey: "clickhouse-viewer.delta-interval",
    label: "Trade delta",
    last: k => k === LAST_PRICE,
    toBar: (t, [sell, buy, count, sellAmount, buyAmount, lastPrice, ...fees]) => ({
      t, sell, buy, count, sellAmount, buyAmount, lastPrice, delta: sell - buy,
      fees: feeCurrencies.map((currency, i) => [currency, fees[i] ?? 0]),
    }),
    marks: bar => [{ cls: bar.delta > 0 ? "bar-sell" : "bar-buy", value: bar.delta }],
    tooltip: (bar, interval) => tooltipHtml(bar, interval, names),
  });
  return {
    show(other) {
      feeCurrencies = other.fee_currencies;
      chart.update(other.buckets);
    },
  };
}
