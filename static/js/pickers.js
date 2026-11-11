// Click-to-pick popups for the period fields, in the page's style instead of the browser's:
// - date: a month calendar (Monday first) with Clear and Today;
// - time: hour (00-23), minute and second columns with Now and Clear. Always 24-hour, unlike
//   <input type="time">, which follows the OS locale.
// An icon button inside the field opens the popup; typing in the field still works. Today and
// Now are in the time zone chosen in the header.

import { toInput } from "./format.js";

const pad = n => String(n).padStart(2, "0");
const svg = body => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CLOCK = svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`);
const CALENDAR = svg(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`);

const footer = (left, right) =>
  `<div class="picker-foot"><button type="button" data-act="${left[0]}">${left[1]}</button>` +
  `<button type="button" data-act="${right[0]}">${right[1]}</button></div>`;

// Wraps `input` with an icon button and an empty popup. `onOpen` fills the popup before it shows.
// Returns { popup, set, close }: `set(value)` writes the field and fires input/change.
function popupField(input, icon, title, onOpen) {
  const wrap = document.createElement("div");
  wrap.className = "picker-field";
  input.replaceWith(wrap);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "picker-button";
  button.tabIndex = -1;  // the field itself takes typing
  button.title = title;
  button.innerHTML = icon;

  const popup = document.createElement("div");
  popup.className = "picker-popup";
  popup.hidden = true;
  wrap.append(input, button, popup);

  const outside = e => { if (!wrap.contains(e.target)) close(); };
  function open() {
    popup.hidden = false;
    onOpen();
    document.addEventListener("pointerdown", outside);
  }
  function close() {
    popup.hidden = true;
    document.removeEventListener("pointerdown", outside);
  }
  const set = value => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  button.addEventListener("click", () => popup.hidden ? open() : close());
  wrap.addEventListener("keydown", e => { if (e.key === "Escape" || e.key === "Enter") close(); });
  return { popup, set, close };
}

// ---- time ----

const TIME_COLUMNS = [24, 60, 60];  // values per column: hours, minutes, seconds

// [h, m, s] of an "H:MM" or "HH:MM:SS" value, or null if it doesn't parse.
function timeParts(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function initTimePicker(input) {
  const { popup, set, close } = popupField(input, CLOCK, "Pick a time", () => mark(true));
  popup.innerHTML = `<div class="time-cols">${TIME_COLUMNS.map(n =>
    `<div class="time-col">${Array.from({ length: n }, (_, i) =>
      `<button type="button" tabindex="-1" data-v="${i}">${pad(i)}</button>`).join("")}</div>`).join("")}</div>` +
    footer(["now", "Now"], ["clear", "Clear"]);
  const columns = [...popup.querySelectorAll(".time-col")];

  // Highlight the field's value; with `scroll`, centre it in each column.
  function mark(scroll) {
    const value = timeParts(input.value);
    columns.forEach((col, c) => {
      for (const b of col.children) b.setAttribute("aria-pressed", Number(b.dataset.v) === value?.[c]);
      const selected = value && col.children[value[c]];
      if (scroll) col.scrollTop = selected ? selected.offsetTop - (col.clientHeight - selected.offsetHeight) / 2 : 0;
    });
  }

  popup.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "now") { set(toInput(Date.now()).time); mark(true); return; }
    if (act === "clear") { set(""); close(); return; }
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    const value = timeParts(input.value) ?? [0, 0, 0];
    value[columns.indexOf(b.parentElement)] = Number(b.dataset.v);
    set(value.map(pad).join(":"));
    mark(false);
  });
  input.addEventListener("input", () => { if (!popup.hidden) mark(true); });
}

// ---- date ----

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const iso = ms => new Date(ms).toISOString().slice(0, 10);

export function initDatePicker(input) {
  let year, month;  // the month shown, month 0-based
  const { popup, set, close } = popupField(input, CALENDAR, "Pick a date", () => {
    const [y, m] = (input.value || toInput(Date.now()).date).split("-").map(Number);
    year = y;
    month = m - 1;
    render();
  });

  // Six weeks from the Monday on or before the 1st, so the grid's height never changes.
  function render() {
    const first = Date.UTC(year, month, 1);
    const offset = (new Date(first).getUTCDay() + 6) % 7;
    const today = toInput(Date.now()).date;
    const days = Array.from({ length: 42 }, (_, i) => {
      const ms = Date.UTC(year, month, 1 + i - offset), d = new Date(ms), value = iso(ms);
      const cls = [d.getUTCMonth() !== month && "other", value === today && "today"].filter(Boolean).join(" ");
      return `<button type="button" tabindex="-1" data-date="${value}" class="${cls}"` +
        ` aria-pressed="${value === input.value}">${d.getUTCDate()}</button>`;
    });
    popup.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-act="prev" title="Previous month">‹</button>
        <b>${MONTH.format(first)}</b>
        <button type="button" class="cal-nav" data-act="next" title="Next month">›</button>
      </div>
      <div class="cal-grid">${WEEKDAYS.map(w => `<span class="wd">${w}</span>`).join("")}${days.join("")}</div>` +
      footer(["clear", "Clear"], ["today", "Today"]);
  }

  popup.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "prev" || act === "next") {
      month += act === "prev" ? -1 : 1;
      if (month < 0) { month = 11; year--; }
      if (month > 11) { month = 0; year++; }
      render();
      return;
    }
    if (act === "today") { set(toInput(Date.now()).date); close(); return; }
    if (act === "clear") { set(""); close(); return; }
    const date = e.target.closest("button[data-date]")?.dataset.date;
    if (date) { set(date); close(); }
  });
}
