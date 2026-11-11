// Market depth bar chart: per interval, the average quote value of the book within 2% of mid,
// asks going up in the sell colour and bids going down in the buy colour (as in the ladder).
//
// Input is the server's 1-minute buckets ([start_ms, bid_depth_sum, ask_depth_sum,
// spread_percent_sum, snapshots]; the spread is for spread-chart.js);
// an interval's average is over all snapshots in it.

import { fmtMinute, initBarChart, tickLabel } from "./bar-chart.js";
import { message } from "./dom.js";
import { num } from "./format.js";

function toBar(t, [bidSum, askSum, , count]) {
  return count
    ? { t, count, bid: bidSum / count, ask: askSum / count }
    : { t, count, bid: 0, ask: 0 };
}

function tooltipHtml(bar, interval) {
  const time = `<div class="tip-time">${fmtMinute(bar.t)} → ${fmtMinute(bar.t + interval)}</div>`;
  if (!bar.count) return `${time}<div class="tip-row muted"><span>No snapshots</span></div>`;
  return `${time}
    <div class="tip-row"><span><i class="swatch swatch-sell"></i>Ask depth</span><b>${num(bar.ask, 2)}</b></div>
    <div class="tip-row"><span><i class="swatch swatch-buy"></i>Bid depth</span><b>${num(bar.bid, 2)}</b></div>
    <div class="tip-row"><span>Bid − ask</span><span>${num(bar.bid - bar.ask, 2)}</span></div>
    <div class="tip-row"><span>Snapshots</span><span>${bar.count}</span></div>`;
}

// The chart itself is drawn by initDepthChart() once this is in the page.
export function renderDepth({ buckets }) {
  if (!buckets.length) return message("No market depth data in this period.");
  return `
    <div class="chart-block" id="depth">
      <div class="chart-head">
        <div class="chart-title muted">Average quote within 2% of mid per bar</div>
        <div class="chart-key">
          <i class="swatch swatch-sell"></i>asks
          <i class="swatch swatch-buy"></i>bids
        </div>
        <label class="inline">Interval <select id="depth-interval"></select></label>
      </div>
      <div class="chart"></div>
    </div>`;
}

// `block` holds an interval <select> and a `.chart` element; `period` is { start, end } in epoch ms.
export function initDepthChart(block, buckets, period) {
  initBarChart(block.querySelector("select"), block.querySelector(".chart"), buckets, period, {
    storeKey: "clickhouse-viewer.depth-interval",
    label: "Market depth",
    toBar,
    marks: bar => [{ cls: "bar-sell", value: bar.ask }, { cls: "bar-buy", value: -bar.bid }],
    tooltip: tooltipHtml,
    yLabel: (v, step) => tickLabel(Math.abs(v), step),  // bids are drawn below zero but are positive
  });
}
