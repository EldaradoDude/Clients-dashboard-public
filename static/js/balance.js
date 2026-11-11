// Balance panel: the latest base and quote balance in the period, and their history as bars
// (available, with reserved stacked on top), base and quote charts side by side. With several accounts the
// latest balances are a table with a row per account and a combined row, and the chart shows the
// combined balance or one account's.
//
// Below them, a collapsible table of each account's balance changes per minute, with "Go to".
//
// Input is the /api/balance result: per account, its latest balance and its buckets, the latest
// balance per minute: [start_ms, base_total, base_available, base_reserved, quote_total,
// quote_available, quote_reserved], null where not reported. A bar shows the latest balance in
// its interval.

import { fmtMinute, initBarChart } from "./bar-chart.js";
import { esc, fitStat, message, stat } from "./dom.js";
import { accountLabel, accountName, fmtAge, fmtTime, getTimeZone, num } from "./format.js";
import { gotoTools } from "./table-goto.js";

const STORE_KEY = "clickhouse-viewer.balance-interval";
const SCALE_KEY = "clickhouse-viewer.balance-scale";  // "zero" or "zoomed"
const HISTORY_LIMIT = 5000;  // rows listed in the balance history table
export const SIDES = ["base", "quote"];
const PARTS = ["total", "available", "reserved"];
const FIELDS = SIDES.flatMap(side => PARTS.map(part => `${side}_${part}`));

const amount = x => x == null ? "–" : num(x);

// The asset name from the first account that reports it (mexc can leave the base out).
export const assetName = (accounts, side) => accounts.map(a => a.latest?.[`${side}_asset`]).find(Boolean) || side;

const sumOrNull = values => {
  const reported = values.filter(v => v != null);
  return reported.length ? reported.reduce((a, b) => a + b, 0) : null;
};

// The sum of the accounts' latest balances; observed_ms is the oldest of their observations.
export function combinedLatest(accounts) {
  const latest = accounts.map(a => a.latest).filter(Boolean);
  return {
    ...Object.fromEntries(FIELDS.map(f => [f, sumOrNull(latest.map(l => l[f]))])),
    observed_ms: Math.min(...latest.map(l => l.observed_ms)),
  };
}

// Per minute that any account reported, the sum over accounts of each one's latest values so far:
// an account that skips a minute counts with its previous values, not as zero.
function combinedBuckets(accounts) {
  const times = [...new Set(accounts.flatMap(a => a.buckets.map(b => b[0])))].sort((x, y) => x - y);
  const byTime = accounts.map(a => new Map(a.buckets.map(b => [b[0], b])));
  const current = accounts.map(() => new Array(FIELDS.length).fill(null));
  return times.map(t => {
    byTime.forEach((buckets, i) => {
      buckets.get(t)?.slice(1).forEach((v, k) => { if (v != null) current[i][k] = v; });
    });
    return [t, ...FIELDS.map((_, k) => sumOrNull(current.map(values => values[k])))];
  });
}

// ---- single account: stat tiles ----

function assetStats(latest, side, name) {
  return PARTS.map(part => fitStat(`${name} ${part}`, latest[`${side}_${part}`])).join("");
}

// The account observation behind the latest balance can be much older than the period end.
function timeStats(latest, end) {
  return (
    stat("Account observed", fmtTime(latest.observed_ms)) +
    stat("Age at period end", fmtAge(end - latest.observed_ms))
  );
}

// ---- several accounts: table ----

function balanceRow(name, latest, end, cls = "") {
  const values = latest
    ? FIELDS.map(f => `<td${f.endsWith("_total") ? ` class="col-total"` : ""}>${amount(latest[f])}</td>`).join("") +
      `<td>${fmtTime(latest.observed_ms)}</td><td>${fmtAge(end - latest.observed_ms)}</td>`
    : `<td colspan="${FIELDS.length + 2}" class="muted">No observations in this period</td>`;
  return `<tr class="${cls}"><td>${name}</td>${values}</tr>`;
}

// Says which accounts the combined values leave out because they don't report an asset.
export function missingNote(accounts, names) {
  const withData = accounts.filter(a => a.latest);
  const notes = SIDES.map(side => {
    const missing = withData.filter(a => a.latest[`${side}_total`] == null);
    return missing.length
      ? `${esc(names[side])} is not reported by ${missing.map(a => esc(accountLabel(a))).join(", ")}; ` +
        `the combined ${esc(names[side])} leaves ${missing.length > 1 ? "them" : "it"} out.`
      : "";
  }).filter(Boolean);
  return notes.length ? `<div class="note">${notes.join("<br>")}</div>` : "";
}

function balanceTable(accounts, names, end) {
  const head = SIDES.flatMap(side => PARTS.map(part =>
    `<th${part === "total" ? ` class="col-total"` : ""}>${esc(names[side])} ${part}</th>`)).join("");
  return `
    <div class="scroll-x">
      <table class="summary balances">
        <thead><tr><th>Account</th>${head}<th>Observed</th><th>Age at end</th></tr></thead>
        <tbody>
          ${accounts.map(a => balanceRow(esc(accountName(a.venue, a.account)), a.latest, end)).join("")}
          ${balanceRow(`Combined <span class="muted">(oldest observation)</span>`, combinedLatest(accounts), end, "total")}
        </tbody>
      </table>
    </div>
    ${missingNote(accounts, names)}`;
}

// ---- history table ----

// Each account's balance changes, newest first: the minutes whose values differ from the
// account's previous minute (an unchanged balance is reported every minute by some sources).
function historyRows(accounts) {
  const rows = accounts.flatMap(a => a.buckets.filter((b, i) =>
    i === 0 || b.slice(1).some((v, k) => v !== a.buckets[i - 1][k + 1])).map(b => ({ a, b })));
  return rows.sort((x, y) => y.b[0] - x.b[0]);
}

// Hidden until its summary row is clicked.
function historyToggle(accounts, names) {
  const all = historyRows(accounts), rows = all.slice(0, HISTORY_LIMIT);
  const many = accounts.length > 1;
  const label = all.length > rows.length ? `latest ${rows.length} of ${all.length} changes` : `${all.length} changes`;
  const note = all.length > rows.length
    ? `<div class="note">Only the latest ${rows.length} changes are listed.</div>` : "";
  const head = SIDES.flatMap(side => PARTS.map(part =>
    `<th${part === "total" ? ` class="col-total"` : ""}>${esc(names[side])} ${part}</th>`)).join("");
  const body = rows.map(({ a, b }) => `
    <tr data-t="${b[0]}">
      <td>${fmtMinute(b[0])}</td>
      ${many ? `<td>${esc(accountName(a.venue, a.account))}</td>` : ""}
      ${b.slice(1).map((v, k) => `<td${FIELDS[k].endsWith("_total") ? ` class="col-total"` : ""}>${amount(v)}</td>`).join("")}
    </tr>`).join("");
  return `
    <details class="table-toggle">
      <summary>Balance table <span class="muted">${label}</span></summary>
      ${note}
      ${gotoTools()}
      <div class="scroll">
        <table class="balances balance-history">
          <thead><tr><th>Minute (${esc(getTimeZone())})</th>${many ? "<th>Account</th>" : ""}${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </details>`;
}

// ---- chart ----

function tooltipHtml(bar, interval, name, scope) {
  const time = `<div class="tip-time">${fmtMinute(bar.t)} → ${fmtMinute(bar.t + interval)}</div>`;
  if (bar.total == null) return `${time}<div class="tip-row muted"><span>No observations</span></div>`;
  return `${time}
    <div class="tip-row"><span>${esc(name)} total</span><b>${amount(bar.total)}</b></div>
    <div class="tip-row"><span><i class="swatch swatch-available"></i>Available</span><span>${amount(bar.available)}</span></div>
    <div class="tip-row"><span><i class="swatch swatch-reserved"></i>Reserved</span><span>${amount(bar.reserved)}</span></div>
    <div class="tip-row muted"><span>${esc(scope)}, latest in interval</span></div>`;
}

// Available from 0 and reserved stacked on it; just the total if the split is not reported.
function marks(bar) {
  if (bar.available == null || bar.reserved == null) {
    return [{ cls: "bar-available", value: bar.total }, { cls: "bar-reserved", value: null }];
  }
  return [
    { cls: "bar-available", value: bar.available, square: bar.reserved > 0 },
    { cls: "bar-reserved", value: bar.reserved, from: bar.available },
  ];
}

// The chart for one asset; `offset` is where its three values start in a bucket, scope()
// names what the chart shows (combined, or an account), and zoomed() says whether the y axis
// fits the values.
const assetChart = (name, offset, scope, zoomed) => ({
  storeKey: STORE_KEY,
  label: `${name} balance`,
  last: true,
  zoomed,
  toBar: (t, values) => {
    const [total, available, reserved] = values.slice(offset, offset + 3);
    return { t, total, available, reserved };
  },
  marks,
  tooltip: (bar, interval) => tooltipHtml(bar, interval, name, scope()),
});

function readScale() {
  try { return localStorage.getItem(SCALE_KEY) === "zoomed" ? "zoomed" : "zero"; } catch { return "zero"; }
}

// What the chart can show: the combined balance (with several accounts), then each account.
function chartSeries(accounts) {
  const each = accounts.map(a => ({ label: accountName(a.venue, a.account), buckets: a.buckets }));
  return accounts.length > 1 ? [{ label: "Combined", buckets: combinedBuckets(accounts) }, ...each] : each;
}

// `data` is the /api/balance result; `end` is the period end in epoch ms. The charts are
// drawn by initBalanceCharts() once this is in the page.
export function renderBalance({ accounts }, end) {
  if (!accounts.some(a => a.latest)) {
    return message(`No balance observations for ${accounts.length > 1 ? "these accounts" : "this account"} in this period.`);
  }
  const names = Object.fromEntries(SIDES.map(side => [side, assetName(accounts, side)]));
  const latest = accounts.length > 1
    ? balanceTable(accounts, names, end)
    : `<div class="stats">${SIDES.map(side => assetStats(accounts[0].latest, side, names[side])).join("")}` +
      `${timeStats(accounts[0].latest, end)}</div>`;
  const accountSelect = accounts.length > 1
    ? `<label class="inline">Account <select class="account">${
        chartSeries(accounts).map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join("")}</select></label>`
    : "";
  return `
    ${latest}
    <div class="chart-block" id="balance">
      <div class="chart-head">
        <div class="chart-key chart-title">
          <i class="swatch swatch-available"></i>available
          <i class="swatch swatch-reserved"></i>reserved
        </div>
        <div class="views scale" title="Y axis: from 0, or zoomed to the shown values' min and max">
          <button type="button" data-scale="zero">From 0</button>
          <button type="button" data-scale="zoomed">Zoomed</button>
        </div>
        ${accountSelect}
        <label class="inline">Interval <select class="interval"></select></label>
      </div>
      <div class="chart-pair">
        ${SIDES.map(side => `
          <div>
            <div class="chart-name">${esc(names[side])}</div>
            <div class="chart" data-side="${side}"></div>
          </div>`).join("")}
      </div>
    </div>
    ${historyToggle(accounts, names)}`;
}

// `block` is the #balance element from renderBalance(); `period` is { start, end } in epoch ms.
export function initBalanceCharts(block, { accounts }, period) {
  const series = chartSeries(accounts);
  let shown = series[0];
  let scale = readScale();
  const interval = block.querySelector("select.interval");
  const charts = SIDES.map((side, i) => initBarChart(
    interval, block.querySelector(`.chart[data-side="${side}"]`), shown.buckets, period,
    assetChart(assetName(accounts, side), i * PARTS.length, () => shown.label, () => scale === "zoomed"),
  ));

  const scaleButtons = [...block.querySelectorAll("[data-scale]")];
  const markScale = () => { for (const b of scaleButtons) b.setAttribute("aria-pressed", b.dataset.scale === scale); };
  markScale();
  block.querySelector(".views.scale").addEventListener("click", e => {
    if (!e.target.dataset.scale) return;
    scale = e.target.dataset.scale;
    try { localStorage.setItem(SCALE_KEY, scale); } catch {}
    markScale();
    for (const chart of charts) chart.redraw();
  });

  const select = block.querySelector("select.account");
  select?.addEventListener("change", () => {
    shown = series[select.value];
    for (const chart of charts) chart.update(shown.buckets);
  });
}
