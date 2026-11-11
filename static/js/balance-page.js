// Entry point of balance.html: the selected accounts' balances in the selected period.

import { fetchBalance } from "./api.js";
import { initBalanceCharts, renderBalance } from "./balance.js";
import { $, fitNumbers } from "./dom.js";
import { accountsText, fillPanel, initPage, skippedNote } from "./page.js";
import { initGoto } from "./table-goto.js";

initPage({
  withAccount: true,
  async load(query) {
    $("panel-sub").textContent = accountsText(query);
    const data = await fillPanel(fetchBalance(query), data => skippedNote(query) + renderBalance(data, query.end));
    const stats = $("panel").querySelector(".stats");
    if (stats) fitNumbers(stats);
    if ($("balance")) initBalanceCharts($("balance"), data, query);
    const history = $("panel").querySelector("details.table-toggle");
    if (history) initGoto(history);
  },
});
