// Entry point of trades.html: the selected accounts' trades in the selected period.

import { fetchTrades } from "./api.js";
import { $ } from "./dom.js";
import { accountsText, fillPanel, initPage, skippedNote } from "./page.js";
import { initGoto } from "./table-goto.js";
import { initTradesChart, renderTrades } from "./trades.js";

initPage({
  withAccount: true,
  async load(query) {
    $("panel-sub").textContent = accountsText(query);
    const data = await fillPanel(fetchTrades(query), data => skippedNote(query) + renderTrades(data));
    if (data?.total) {
      initTradesChart($("delta"), data, query);
      initGoto($("panel").querySelector("details.table-toggle"));
    }
  },
});
