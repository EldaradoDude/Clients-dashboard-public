// Entry point of overview.html: for the selected accounts and pair, the current market on their
// exchanges (spread, best bid and ask, mid), their latest balances, and their combined trade stats.

import { fetchBalance, fetchOrderbook, fetchTrades } from "./api.js";
import { $ } from "./dom.js";
import { parseAccount, venueSymbol } from "./filters.js";
import { block, renderBalanceTiles, renderMarket, renderTradeStats } from "./overview.js";
import { accountsText, fillPanel, initPage, skippedNote } from "./page.js";

initPage({
  withAccount: true,
  async load(query) {
    $("panel-sub").textContent = accountsText(query);
    $("panel").innerHTML = skippedNote(query) + `<div class="ov-grid">${
      block("Market", "last snapshot at or before the period end", "ov-market") +
      block("Balances", "latest totals, accounts combined", "ov-balance") +
      block("Trades", "accounts combined, over the period", "ov-trades")}</div>`;

    // The server runs one query at a time, so the fast requests go first.
    const { start, end } = query;
    const venues = [...new Set(query.accounts.map(id => parseAccount(id).venue))];
    const market = Promise.all(venues.map(venue => {
      const symbol = venueSymbol(venue, query.symbol);
      return fetchOrderbook({ venue, symbol, start, end }).then(({ snapshot }) => ({ venue, symbol, snapshot }));
    }));
    const balance = fetchBalance(query);
    const trades = fetchTrades(query);
    await Promise.all([
      fillPanel(market, rows => renderMarket(rows, end), "ov-market"),
      fillPanel(balance, renderBalanceTiles, "ov-balance"),
      fillPanel(trades, renderTradeStats, "ov-trades"),
    ]);
  },
});
