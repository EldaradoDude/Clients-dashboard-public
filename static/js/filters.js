// Filter selectors. The order book page has a venue and a symbol selector; the account pages
// (initFilters({ withAccount: true })) have an accounts dropdown with a checkbox per account,
// "venue:account", and a pair selector, whose values are pair keys (ABCUSDT for ABC_USDT, ABC-USDT
// and ABCUSDT), so accounts on venues with different symbol formats can be picked together.
//
// `options` comes from /api/options:
//   { venue: { symbols: [...], accounts: { account: [symbols traded] } } }

import { $, esc } from "./dom.js";
import { accountLabel, accountName } from "./format.js";

const STORE_KEY = "clickhouse-viewer.selection";

let options = {};
let withAccount = false;

const optionList = values => values.map(v => `<option>${esc(v)}</option>`).join("");

// The venue-independent name of a symbol, as query.pair_key on the server.
export const pairKey = symbol => symbol.replace(/[-_]/g, "").toUpperCase();

export function parseAccount(id) {
  const i = id.indexOf(":");
  return { venue: id.slice(0, i), account: id.slice(i + 1) };
}

// The venue's own symbol for a pair key (ABC_USDT on gate for ABCUSDT), or undefined.
export const venueSymbol = (venue, pair) => options[venue]?.symbols.find(s => pairKey(s) === pair);

const venueHasPair = (venue, pair) => options[venue]?.symbols.some(s => pairKey(s) === pair);

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

// Venues with symbols to pick.
const usableVenues = () => Object.keys(options).filter(v => options[v].symbols.length);

// Accounts on venues with symbols, as "venue:account", grouped by venue.
const allAccounts = () => usableVenues().flatMap(v => Object.keys(options[v].accounts).map(a => `${v}:${a}`));

// ---- order book page: venue and symbol ----

function fillVenues(selected) {
  const venues = usableVenues();
  $("venue").innerHTML = optionList(venues);
  $("venue").value = venues.includes(selected) ? selected : venues[0];
}

// `selected` can be in any venue's format: the venue's symbol for the same pair is picked.
function fillVenueSymbols(selected) {
  const symbols = options[$("venue").value].symbols;
  $("symbol").innerHTML = optionList(symbols);
  $("symbol").value = symbols.find(s => selected && pairKey(s) === pairKey(selected)) ?? symbols[0];
}

// ---- account pages: accounts dropdown and pair ----

const accountBoxes = () => [...$("accounts").querySelectorAll("input[data-account]")];
const checkedAccounts = () => accountBoxes().filter(b => b.checked).map(b => b.value);

function accountsSummary() {
  const checked = checkedAccounts(), total = accountBoxes().length;
  $("accounts").querySelector("summary").textContent =
    !checked.length ? "None" :
    checked.length === 1 ? accountLabel(parseAccount(checked[0])) :
    checked.length === total ? `All (${total})` : `${checked.length} accounts`;
  $("accounts").querySelector("input[data-all]").checked = checked.length === total;
}

function fillAccounts(selected) {
  const ids = allAccounts();
  const kept = selected?.filter(id => ids.includes(id)) ?? [];
  const checked = new Set(kept.length ? kept : ids);  // all accounts by default
  const box = (id, text) =>
    `<label class="check"><input type="checkbox" data-account value="${esc(id)}"${checked.has(id) ? " checked" : ""}>${esc(text)}</label>`;
  const groups = usableVenues().map(venue => {
    const ids = Object.keys(options[venue].accounts).map(a => [`${venue}:${a}`, accountName(venue, a)]);
    return ids.length ? `<div class="menu-group">${esc(venue)}</div>${ids.map(([id, a]) => box(id, a)).join("")}` : "";
  });
  $("accounts").querySelector(".menu").innerHTML =
    `<label class="check"><input type="checkbox" data-all>All accounts</label>${groups.join("")}`;
  accountsSummary();
}

// Pairs on the venues of the checked accounts; the ones they traded are listed first.
function fillPairs(selected) {
  const accounts = checkedAccounts().map(parseAccount);
  const keys = symbols => [...new Set(symbols.map(pairKey))].sort();
  const traded = keys(accounts.flatMap(({ venue, account }) => options[venue].accounts[account] ?? []));
  const other = keys(accounts.flatMap(({ venue }) => options[venue].symbols)).filter(p => !traded.includes(p));
  $("symbol").innerHTML = traded.length
    ? `<optgroup label="Traded by accounts">${optionList(traded)}</optgroup>` +
      `<optgroup label="Other pairs">${optionList(other)}</optgroup>`
    : optionList(other);
  const all = [...traded, ...other];
  $("symbol").value = selected && all.includes(pairKey(selected)) ? pairKey(selected) : all[0] ?? "";
}

function bindAccounts() {
  const dropdown = $("accounts");
  dropdown.addEventListener("change", e => {
    if (e.target.matches("[data-all]")) for (const b of accountBoxes()) b.checked = e.target.checked;
    accountsSummary();
    fillPairs($("symbol").value);
  });
  document.addEventListener("click", e => { if (!dropdown.contains(e.target)) dropdown.open = false; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") dropdown.open = false; });
}

// ---- selection ----

// The remembered selection, overridden by the URL: ?venue=&symbol= and ?account= (repeated,
// "venue:account"; a plain account name is taken to be on ?venue=).
function initialSelection() {
  const selection = readStored();
  const url = new URLSearchParams(location.search);
  for (const key of ["venue", "symbol"]) if (url.get(key)) selection[key] = url.get(key);
  const venue = url.get("venue") ?? selection.venue;
  const accounts = url.getAll("account").map(a => a.includes(":") ? a : `${venue}:${a}`);
  if (accounts.length) selection.accounts = accounts;
  // Selections stored before several accounts could be picked.
  else if (!selection.accounts && selection.account) selection.accounts = [`${selection.venue}:${selection.account}`];
  return selection;
}

// Returns false, leaving the selectors empty, when the user has nothing to pick on this page.
export function initFilters(filterOptions, { withAccount: hasAccount }) {
  options = filterOptions;
  withAccount = hasAccount;
  if (!(withAccount ? allAccounts() : usableVenues()).length) return false;

  const initial = initialSelection();
  if (withAccount) {
    fillAccounts(initial.accounts);
    fillPairs(initial.symbol);
    bindAccounts();
  } else {
    fillVenues(initial.venue ?? "mexc");
    fillVenueSymbols(initial.symbol);
    $("venue").addEventListener("change", () => fillVenueSymbols($("symbol").value));
  }
  return true;
}

// { venue, symbol } on the order book page; { accounts: ["venue:account", ...], symbol: pair }
// on the account pages.
export function getSelection() {
  return withAccount
    ? { accounts: checkedAccounts(), symbol: $("symbol").value }
    : { venue: $("venue").value, symbol: $("symbol").value };
}

// The selection as URL parameters (accounts as repeated `account`).
export function selectionParams(selection = getSelection()) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) {
    for (const v of [value].flat()) params.append(key === "accounts" ? "account" : key, v);
  }
  return params;
}

// The selected accounts whose venue lists the pair, and the others (`skipped`).
export function splitAccounts({ accounts, symbol }) {
  const listed = accounts.filter(id => venueHasPair(parseAccount(id).venue, symbol));
  return { accounts: listed, skipped: accounts.filter(id => !listed.includes(id)) };
}

// Merged into the stored selection, so a page without accounts keeps the remembered ones.
export function saveSelection() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStored(), ...getSelection() })); } catch {}
}
