// "Go to" control for a table of rows over time (trades, balance history): a date and a time
// field with the header's pickers; Go scrolls the table to the newest row at or before that
// moment (in the header's time zone) and highlights it.
//
// The table's rows carry their epoch ms in data-t, newest first, and the table sits in a
// `.scroll` element right after gotoTools()'s HTML.

import { fromInput, toInput } from "./format.js";
import { initDatePicker, initTimePicker } from "./pickers.js";

export const gotoTools = () => `
  <div class="table-tools">
    <span class="muted">Go to</span>
    <div class="datetime">
      <input class="goto-date" type="date" aria-label="Go to date">
      <input class="time goto-time" pattern="([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?" placeholder="HH:MM:SS"
             maxlength="8" spellcheck="false" autocomplete="off" aria-label="Go to time, 24-hour">
    </div>
    <button type="button" class="goto">Go</button>
    <span class="goto-note muted"></span>
  </div>`;

// `block` holds gotoTools()'s HTML and the table.
export function initGoto(block) {
  const rows = [...block.querySelectorAll("tbody tr[data-t]")];  // newest first
  if (!rows.length) return;
  const date = block.querySelector(".goto-date"), time = block.querySelector(".goto-time");
  const scroller = block.querySelector(".table-tools + .scroll");
  const note = block.querySelector(".goto-note");
  const newest = toInput(Number(rows[0].dataset.t));  // start at the newest row
  date.value = newest.date;
  time.value = newest.time;
  initDatePicker(date);
  initTimePicker(time);

  let found = null;
  const go = () => {
    const target = fromInput(date.value, time.value);
    if (Number.isNaN(target)) {
      note.textContent = "Enter a date and a time as HH:MM:SS.";
      return;
    }
    let row = rows.find(r => Number(r.dataset.t) <= target);
    note.textContent = row ? "" : "Before the oldest listed row; showing it.";
    row ??= rows.at(-1);
    found?.classList.remove("found");
    (found = row).classList.add("found");
    const head = scroller.querySelector("thead").offsetHeight;
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - head;
  };
  block.querySelector("button.goto").addEventListener("click", go);
  for (const input of [date, time]) input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
}
