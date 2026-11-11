// Setup shared by the viewer pages: filters, period controls, page navigation and
// the result panels (#panel, and others a page fills itself).

import { fetchMe, fetchOptions, logout, toLogin } from "./api.js";
import { $, esc, message } from "./dom.js";
import { getSelection, initFilters, parseAccount, saveSelection, selectionParams, splitAccounts } from "./filters.js";
import { accountLabel, fromInput, getTimeZone, LOCAL_TZ, setTimeZone, timeZones, toInput } from "./format.js";
import { initDatePicker, initTimePicker } from "./pickers.js";

const DEFAULT_PERIOD_MIN = 60;

// Write epoch ms `ms` into the date and time fields `id`-date and `id`-time.
function writeTime(id, ms) {
  const { date, time } = toInput(ms);
  $(`${id}-date`).value = date;
  $(`${id}-time`).value = time;
}

const readTime = id => fromInput($(`${id}-date`).value, $(`${id}-time`).value);

function setPeriod(minutes) {
  const now = Date.now();
  writeTime("end", now);
  writeTime("start", now - minutes * 60e3);
}

// The active preset (minutes) or null for a fixed period. While a preset is active, every Load
// moves the period to end now; editing the period fields makes it fixed. Remembered across pages.
const PRESET_KEY = "clickhouse-viewer.period-preset";
let preset = null;

function setPreset(minutes) {
  preset = minutes;
  for (const b of document.querySelectorAll("#presets button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.min) === minutes));
  }
  try { localStorage.setItem(PRESET_KEY, minutes ? String(minutes) : ""); } catch {}
}

function storedPreset() {
  let stored = null;
  try { stored = localStorage.getItem(PRESET_KEY); } catch {}
  if (stored === "") return null;  // a fixed period was chosen last
  const minutes = Number(stored);
  return minutes > 0 ? minutes : DEFAULT_PERIOD_MIN;
}

// The period from the URL (?period=minutes for a preset, ?start=&end= epoch ms for a fixed period)
// when a link passed one, else the remembered preset (the default one if none).
function initPeriod() {
  const url = new URLSearchParams(location.search);
  const minutes = Number(url.get("period"));
  const start = Number(url.get("start")), end = Number(url.get("end"));
  if (minutes > 0) {
    setPreset(minutes);
  } else if (start && end && start < end) {
    writeTime("start", start);
    writeTime("end", end);
    setPreset(null);
    return;
  } else {
    // A fixed period isn't remembered, so fall back to the default preset then.
    setPreset(storedPreset() ?? DEFAULT_PERIOD_MIN);
  }
  setPeriod(preset);
}

// { start, end } in epoch ms, or null if the inputs don't form a valid period.
function readPeriod() {
  const start = readTime("start");
  const end = readTime("end");
  return Number.isNaN(start) || Number.isNaN(end) || start >= end ? null : { start, end };
}

// A zone's current UTC offset as { text: "UTC+2" | "UTC-3:30" | "UTC+0", minutes } (with daylight
// saving, so it can differ at other times of the year).
function utcOffset(tz, now) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(now).find(p => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return { text: m ? name.replace("GMT", "UTC") : "UTC+0", minutes };
}

// The time zone selector, each zone with its current UTC offset, sorted by the offset (UTC first
// among UTC+0, then by name). Changing the zone keeps the period (the same instants, shown in the
// new zone) and calls `reload` so every time on the page is redrawn in it.
function initTimeZone(reload) {
  const select = $("tz");
  const now = new Date();
  const zones = timeZones().map(tz => ({ tz, offset: utcOffset(tz, now) }))
    .sort((a, b) => a.offset.minutes - b.offset.minutes || (b.tz === "UTC") - (a.tz === "UTC") || a.tz.localeCompare(b.tz));
  const label = ({ tz, offset }) => tz === "UTC" ? "UTC"
    : `${tz} (${offset.text}${tz === LOCAL_TZ ? ", local" : ""})`;
  select.innerHTML = zones.map(z => `<option value="${esc(z.tz)}">${esc(label(z))}</option>`).join("");
  select.value = getTimeZone();
  select.addEventListener("change", () => {
    const period = readPeriod();
    setTimeZone(select.value);
    if (period) {
      writeTime("start", period.start);
      writeTime("end", period.end);
    }
    reload();
  });
}

// Links to the other pages carry the current selection and period.
function bindNav() {
  for (const link of document.querySelectorAll("nav a")) {
    link.addEventListener("click", () => {
      const params = selectionParams();
      const period = readPeriod();
      if (preset) {
        params.set("period", preset);
      } else if (period) {
        params.set("start", period.start);
        params.set("end", period.end);
      }
      link.search = params;
    });
  }
}

// A button at the end of the header hides it; a small floating button brings it back. The choice
// is remembered across pages.
const HEADER_KEY = "clickhouse-viewer.header-hidden";
function initHeaderToggle() {
  const hide = document.createElement("button");
  hide.id = "hide-header";
  hide.title = "Hide the header";
  hide.textContent = "Hide ▴";
  $("logout").after(hide);

  const show = document.createElement("button");
  show.id = "show-header";
  show.title = "Show the header";
  show.textContent = "Filters ▾";
  document.body.append(show);

  const set = hidden => {
    document.body.classList.toggle("header-hidden", hidden);
    try { localStorage.setItem(HEADER_KEY, hidden ? "1" : ""); } catch {}
  };
  hide.addEventListener("click", () => set(true));
  show.addEventListener("click", () => set(false));
  let stored = false;
  try { stored = localStorage.getItem(HEADER_KEY) === "1"; } catch {}
  set(stored);
}

// The logged-in user's name and the logout button in the header.
async function initUser() {
  $("logout").addEventListener("click", async () => {
    try { await logout(); } finally { toLogin(); }
  });
  try {
    $("user-name").textContent = (await fetchMe()).username;
  } catch {
    // A 401 already opens the login page.
  }
}

// Fill the panel `id` with render(data) and return data, or show the error and return null.
export async function fillPanel(request, render, id = "panel") {
  $(id).innerHTML = message("Loading…");
  try {
    const data = await request;
    $(id).innerHTML = render(data);
    return data;
  } catch (e) {
    $(id).innerHTML = message(e.message, true);
    return null;
  }
}

// The panel subtitle for the accounts of a query: the account, or how many.
export const accountsText = ({ accounts, symbol }) =>
  `${symbol} · ${accounts.length === 1 ? accountLabel(parseAccount(accounts[0])) : `${accounts.length} accounts`}`;

// A note naming the selected accounts left out because their venue doesn't list the pair.
export const skippedNote = ({ skipped, symbol }) => skipped.length
  ? `<div class="note">Not included, no ${esc(symbol)} on their exchange: ${skipped.map(id => esc(accountLabel(parseAccount(id)))).join(", ")}</div>`
  : "";

// `load(query)` fills the panels; query is { venue, symbol, start, end } or, with `withAccount`
// (the page has the accounts selector), { accounts, skipped, symbol, start, end }: the selected
// accounts whose venue lists the pair, and those that don't.
export async function initPage({ withAccount, load }) {
  initPeriod();
  for (const id of ["start", "end"]) {
    initDatePicker($(`${id}-date`));
    initTimePicker($(`${id}-time`));
  }

  const run = async () => {
    if (preset) setPeriod(preset);
    const period = readPeriod();
    if (!period) {
      $("panel").innerHTML = message("Set a valid period: dates, times as HH:MM:SS (24-hour), and From before To.", true);
      return;
    }
    let selection = getSelection();
    if (withAccount) {
      selection = { ...selection, ...splitAccounts(selection) };
      if (!selection.accounts.length) {
        $("panel").innerHTML = message(selection.skipped.length
          ? `None of the selected accounts' exchanges lists ${selection.symbol}.` : "Select at least one account.", true);
        return;
      }
    }
    saveSelection();
    $("load").disabled = true;
    try {
      await load({ ...selection, ...period });
    } finally {
      $("load").disabled = false;
    }
  };

  $("load").addEventListener("click", run);
  for (const id of ["start-date", "start-time", "end-date", "end-time"]) {
    $(id).addEventListener("keydown", e => { if (e.key === "Enter") run(); });
    // Typing or a picker (which fires "input") makes the period fixed.
    $(id).addEventListener("input", () => setPreset(null));
  }
  let ready = false;  // the filters are filled
  initTimeZone(() => { if (ready && !$("load").disabled) run(); });
  $("presets").addEventListener("click", e => {
    const minutes = e.target.dataset.min;
    if (!minutes) return;
    setPreset(Number(minutes));
    run();
  });
  bindNav();
  initUser();
  initHeaderToggle();

  let usable;
  try {
    usable = initFilters(await fetchOptions(), { withAccount });
  } catch (e) {
    $("panel").innerHTML = message(`Could not load filter values: ${e.message}`, true);
    return;
  }
  if (!usable) {
    const needed = withAccount ? "an account and a symbol" : "a symbol";
    $("panel").innerHTML = message(`Nothing to show: you have not been given access to ${needed} yet.`, true);
    $("load").disabled = true;
    return;
  }
  ready = true;
  run();
}
