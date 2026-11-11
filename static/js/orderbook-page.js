// Entry point of orderbook.html: market depth and spread over the selected period, and its
// last L2 snapshot.

import { fetchDepth, fetchMid, fetchOrderbook } from "./api.js";
import { initDepthChart, renderDepth } from "./depth-chart.js";
import { $ } from "./dom.js";
import { initBook, renderBook } from "./orderbook.js";
import { fillPanel, initPage } from "./page.js";
import { initSpreadCharts, renderSpread } from "./spread-chart.js";

initPage({
  withAccount: false,
  async load(query) {
    const sub = `${query.venue} · ${query.symbol}`;
    for (const id of ["panel-sub", "depth-sub", "spread-sub"]) $(id).textContent = sub;
    // The server runs one query at a time, so the fast requests go first; the depth query
    // (which also has the spread percent) is the slow one.
    const book = fetchOrderbook(query);
    const mid = fetchMid(query);
    const depth = fetchDepth(query);
    await Promise.all([
      fillPanel(book, data => renderBook(data, query.end))
        .then(data => { if (data?.snapshot) initBook($("panel"), data.snapshot, query.symbol); }),
      fillPanel(depth, renderDepth, "depth-panel")
        .then(data => { if (data?.buckets.length) initDepthChart($("depth"), data.buckets, query); }),
      fillPanel(Promise.all([depth, mid]), renderSpread, "spread-panel")
        .then(data => { if ($("spread")) initSpreadCharts($("spread"), data, query); }),
    ]);
  },
});
