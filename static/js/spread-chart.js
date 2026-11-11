// Spread panel with two views over the same interval selector: the average spread in percent
// as bars, and the average best bid, best ask and mid price as lines.
//
// Input is the server's 1-minute buckets: /api/depth ([start_ms, bid_depth_sum, ask_depth_sum,
// spread_percent_sum, snapshots]) for the spread and /api/mid ([start_ms, best_bid_sum,
// best_ask_sum, mid_price_sum, snapshots]) for the prices. Averages are over all snapshots.

import { fmtMinute, initBarChart, initViewSwitch, tickLabel } from "./bar-chart.js";
import { message } from "./dom.js";
import { num } from "./format.js";

const STORE_KEY = "clickhouse-viewer.spread-interval";
const VIEW_KEY = "clickhouse-viewer.spread-view";
const VIEWS = { spread: "Spread %", prices: "Bid / ask / mid" };

const timeRow = (bar, interval) =>
  `<div class="tip-time">${fmtMinute(bar.t)} → ${fmtMinute(bar.t + interval)}</div>`;
const noSnapshots = `<div class="tip-row muted"><span>No snapshots</span></div>`;

const SPREAD_CHART = {
  storeKey: STORE_KEY,
  label: "Spread percent",
  toBar: (t, [, , spreadSum, count]) => ({ t, count, spread: count ? spreadSum / count : 0 }),
  marks: bar => [{ cls: "bar-neutral", value: bar.spread }],
  tooltip: (bar, interval) => timeRow(bar, interval) + (bar.count ? `
    <div class="tip-row"><span><i class="swatch swatch-neutral"></i>Spread</span><b>${num(bar.spread, 4)}%</b></div>
    <div class="tip-row"><span>Snapshots</span><span>${bar.count}</span></div>` : noSnapshots),
  yLabel: (v, step) => `${tickLabel(v, step)}%`,
};

const PRICE_CHART = {
  storeKey: STORE_KEY,
  label: "Best bid, best ask and mid price",
  line: true,
  toBar: (t, [bidSum, askSum, midSum, count]) => count
    ? { t, count, bid: bidSum / count, ask: askSum / count, mid: midSum / count }
    : { t, count, bid: null, ask: null, mid: null },
  marks: bar => [
    { cls: "line-ask", value: bar.ask },
    { cls: "line-mid", value: bar.mid },
    { cls: "line-bid", value: bar.bid },
  ],
  tooltip: (bar, interval) => timeRow(bar, interval) + (bar.count ? `
    <div class="tip-row"><span><i class="swatch swatch-sell"></i>Best ask</span><b>${num(bar.ask, 10)}</b></div>
    <div class="tip-row"><span><i class="swatch swatch-mid"></i>Mid</span><b>${num(bar.mid, 10)}</b></div>
    <div class="tip-row"><span><i class="swatch swatch-buy"></i>Best bid</span><b>${num(bar.bid, 10)}</b></div>
    <div class="tip-row"><span>Snapshots</span><span>${bar.count}</span></div>` : noSnapshots),
};

// `data` is [/api/depth result, /api/mid result]. The charts are drawn by initSpreadCharts()
// once this is in the page.
export function renderSpread([depth, mid]) {
  if (!depth.buckets.length && !mid.buckets.length) return message("No order book data in this period.");
  const buttons = Object.entries(VIEWS).map(([view, label]) =>
    `<button data-view="${view}">${label}</button>`).join("");
  return `
    <div class="chart-block" id="spread">
      <div class="chart-head">
        <div class="views chart-title">${buttons}</div>
        <div class="chart-key" data-view="spread">
          <i class="swatch swatch-neutral"></i>average spread, % of mid
        </div>
        <div class="chart-key" data-view="prices">
          <i class="swatch swatch-sell"></i>best ask
          <i class="swatch swatch-mid"></i>mid
          <i class="swatch swatch-buy"></i>best bid
        </div>
        <label class="inline">Interval <select id="spread-interval"></select></label>
      </div>
      <div class="chart" data-view="spread"></div>
      <div class="chart" data-view="prices"></div>
    </div>`;
}

// `block` is the #spread element from renderSpread(); `period` is { start, end } in epoch ms.
export function initSpreadCharts(block, [depth, mid], period) {
  const select = block.querySelector("select");
  const chartEl = view => block.querySelector(`.chart[data-view="${view}"]`);
  initBarChart(select, chartEl("spread"), depth.buckets, period, SPREAD_CHART);
  initBarChart(select, chartEl("prices"), mid.buckets, period, PRICE_CHART);

  initViewSwitch(block, VIEW_KEY, "spread");
}
