// Chart over time with an interval selector, shared by the trade delta, market depth, spread
// and balance charts. Bars grow up or down from a zero line (an interval can have one bar each way);
// in line mode each series is a line through the interval centres and the y axis fits the data.
//
// Input is the server's buckets ([start_ms, ...values]); the values of the buckets in an
// interval are summed (or, for levels such as balances, the latest one is kept) here, so
// changing the interval needs no request.

import { fmtTime, zoneOffset } from "./format.js";

const INTERVALS = [
  ["1m", 60e3], ["5m", 300e3], ["15m", 900e3], ["30m", 1800e3],
  ["1h", 3600e3], ["4h", 14400e3], ["1d", 86400e3],
];
const AUTO_TARGET_BARS = 120;  // "Auto" picks the smallest interval with at most this many bars
const MAX_BARS = 1500;  // intervals that would draw more bars are disabled

const HEIGHT = 260;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 64 };
const RADIUS = 4;  // rounded data end of each bar

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const fmtMinute = ms => fmtTime(ms).slice(0, 16);

// A y tick label with as many decimals as the tick step needs.
export const tickLabel = (v, step) =>
  step >= 1000 ? compact.format(v) : v.toFixed(Math.max(0, Math.ceil(-Math.log10(step))));

// ---- data ----

// Intervals start on whole minutes/hours/days of the chosen time zone (its offset at the period start).
const firstBarStart = (start, interval) => {
  const offset = zoneOffset(start);
  return Math.floor((start + offset) / interval) * interval - offset;
};
const barCount = ({ start, end }, interval) => Math.ceil((end - firstBarStart(start, interval)) / interval);

// One { t, sums } per interval across the whole period, empty intervals included;
// sums[k] is the total of value k over the buckets in the interval or, where `last` (true, or a
// function of k) says so, the value of the latest bucket in the interval where it is not null
// (null if there is none).
function aggregate(buckets, period, interval, last) {
  const width = (buckets[0]?.length ?? 1) - 1;
  const keepLast = Array.from({ length: width }, (_, k) => typeof last === "function" ? last(k) : !!last);
  const first = firstBarStart(period.start, interval);
  const slots = Array.from({ length: barCount(period, interval) }, (_, i) =>
    ({ t: first + i * interval, sums: keepLast.map(l => l ? null : 0) }));
  for (const [t, ...values] of buckets) {  // ascending, so a later bucket overwrites
    const slot = slots[Math.floor((t - first) / interval)];
    if (!slot) continue;
    values.forEach((v, k) => {
      if (!keepLast[k]) slot.sums[k] += v ?? 0;
      else if (v != null) slot.sums[k] = v;
    });
  }
  return slots;
}

// ---- scales ----

function niceStep(range, targetTicks = 5) {
  const raw = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const f = raw / magnitude;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * magnitude;
}

// Y domain rounded out to whole tick steps. Bars include 0; lines, and bars when zoomed (`fit`),
// span the values with a little headroom.
function yDomain(values, fit) {
  let lo, hi;
  if (fit) {
    lo = Math.min(...values);
    hi = Math.max(...values);
    if (!values.length) [lo, hi] = [0, 1];
    const pad = (hi - lo) * 0.05 || Math.abs(hi) * 1e-3 || 1;
    lo -= pad;
    hi += pad;
  } else {
    lo = Math.min(0, ...values);
    hi = Math.max(0, ...values);
    if (lo === hi) hi = 1;
  }
  const step = niceStep(hi - lo);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

function xLabel(t, interval, period) {
  const time = fmtTime(t);
  if (interval >= 86400e3) return time.slice(5, 10);
  if (period.end - period.start > 86400e3) return `${time.slice(5, 10)} ${time.slice(11, 16)}`;
  return time.slice(11, 16);
}

// ---- drawing ----

// A bar from the baseline y0 to the value y1, rounded only at the value end (not if `square`).
function barPath(x, w, y0, y1, square = false) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = square ? 0 : Math.min(RADIUS, w / 2, h);
  const dir = y1 < y0 ? 1 : -1;  // 1 = bar goes up
  return `M${x},${y0}V${y1 + dir * r}Q${x},${y1} ${x + r},${y1}` +
         `H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + dir * r}V${y0}Z`;
}

// One path per series (the k-th mark of every interval); a null value breaks the line.
// A point with no neighbour gets a dot, as a lone line point would not show.
function linePaths(marks, cx, y) {
  const series = marks[0]?.length ?? 0;
  let out = "";
  for (let k = 0; k < series; k++) {
    let d = "", dots = "";
    marks.forEach((ms, i) => {
      const v = ms[k].value;
      if (v == null) return;
      const px = cx(i).toFixed(1), py = y(v).toFixed(1);
      const joined = marks[i - 1]?.[k].value != null;
      d += `${joined ? "L" : "M"}${px},${py}`;
      if (!joined && marks[i + 1]?.[k].value == null) dots += `<circle cx="${px}" cy="${py}" r="1.5"/>`;
    });
    out += `<g class="${marks[0][k].cls}"><path d="${d}"/>${dots}</g>`;
  }
  return out;
}

function render(el, bars, interval, period, chart) {
  const width = el.clientWidth;
  if (!width) return;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const marks = bars.map(chart.marks);
  const values = marks.flat().filter(m => m.value != null).map(m => (m.from ?? 0) + m.value);
  const zoomed = !chart.line && !!chart.zoomed?.();
  const { lo, hi, step } = yDomain(values, chart.line || zoomed);
  const y = v => MARGIN.top + (hi - v) / (hi - lo) * plotH;
  // Zoomed bars rise from the bottom of the range; the part of a bar below it is cut off.
  const yBar = v => y(Math.max(lo, Math.min(hi, v)));
  const slot = plotW / bars.length;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const barW = Math.max(slot - gap, 0.5);
  const x = i => MARGIN.left + i * slot + gap / 2;

  let grid = "";
  for (let k = 0; k <= Math.round((hi - lo) / step); k++) {
    const v = lo + k * step, py = y(v).toFixed(1);
    grid += `<line class="grid" x1="${MARGIN.left}" x2="${width - MARGIN.right}" y1="${py}" y2="${py}"/>` +
            `<text class="axis" x="${MARGIN.left - 8}" y="${py}" text-anchor="end" dominant-baseline="middle">${chart.yLabel(v, step)}</text>`;
  }

  const every = Math.ceil(bars.length / Math.max(2, Math.floor(plotW / 110)));
  let xLabels = "";
  for (let i = 0; i < bars.length; i += every) {
    xLabels += `<text class="axis" x="${(x(i) + barW / 2).toFixed(1)}" y="${HEIGHT - 8}" text-anchor="middle">` +
               `${xLabel(bars[i].t, interval, period)}</text>`;
  }

  const y0 = y(0);
  const paths = chart.line ? linePaths(marks, i => MARGIN.left + (i + 0.5) * slot, y) :
    marks.map((ms, i) => ms.map(m => m.value
      ? `<path class="${m.cls}" d="${barPath(x(i), barW, yBar(m.from ?? 0), yBar((m.from ?? 0) + m.value), m.square)}"/>`
      : "").join("")).join("");
  const zero = chart.line || y0 < MARGIN.top || y0 > MARGIN.top + plotH ? "" :
    `<line class="zero" x1="${MARGIN.left}" x2="${width - MARGIN.right}" y1="${y0}" y2="${y0}"/>`;

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${chart.label} per ${interval / 60e3} minutes">
      <rect class="hover-col" y="${MARGIN.top}" height="${plotH}" width="${slot}" visibility="hidden"/>
      ${grid}${paths}${zero}
      ${xLabels}
    </svg>
    <div class="tooltip" hidden></div>`;

  const svg = el.querySelector("svg");
  const hoverCol = svg.querySelector(".hover-col");
  const tip = el.querySelector(".tooltip");
  const hide = () => { tip.hidden = true; hoverCol.setAttribute("visibility", "hidden"); };

  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("mousemove", e => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    const i = Math.floor((px - MARGIN.left) / slot);
    if (i < 0 || i >= bars.length) return hide();
    hoverCol.setAttribute("x", MARGIN.left + i * slot);
    hoverCol.setAttribute("visibility", "visible");
    tip.innerHTML = chart.tooltip(bars[i], interval);
    tip.hidden = false;
    const left = px + 14 + tip.offsetWidth > width ? px - 14 - tip.offsetWidth : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${MARGIN.top}px`;
  });
}

// ---- interval selector and view switch ----

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Switches between views in `block`: the buttons with data-view in its `.views` group pick the
// view, and of the other elements with data-view only those of the picked view are shown.
// The choice is remembered under storeKey; `fallback` is the view shown first otherwise.
export function initViewSwitch(block, storeKey, fallback) {
  const views = [...block.querySelectorAll(".views [data-view]")].map(b => b.dataset.view);
  const show = view => {
    for (const el of block.querySelectorAll("[data-view]")) {
      const active = el.dataset.view === view;
      if (el.tagName === "BUTTON") el.setAttribute("aria-pressed", active);
      else el.hidden = !active;
    }
  };
  block.querySelector(".views").addEventListener("click", e => {
    const view = e.target.dataset.view;
    if (!view) return;
    store(storeKey, view);
    show(view);
  });
  const stored = readStored(storeKey);
  show(views.includes(stored) ? stored : fallback);
}

// Draws a chart into the element `el`, with its interval chosen by the <select> `select`.
// Several charts can share one select (with the same storeKey); a chart in a hidden element
// is drawn when it is shown. `period` is { start, end } in epoch ms. `chart` describes it:
//   storeKey             localStorage key for the chosen interval
//   label                what the chart shows, for the SVG's aria-label
//   toBar(t, sums)       the bar object for an interval (it needs `t`)
//   marks(bar)           [{ cls, value }]: bars drawn from 0, where 0 or null draws nothing, or
//                        line points, where null leaves a gap; same series in the same order each
//                        time. A bar can start at `from` instead (for stacking); `square` drops
//                        its rounded end
//   last                 optional, true to keep each value's latest bucket in an interval
//                        rather than summing them (for levels such as balances), or a function
//                        of the value's index for some values only
//   tooltip(bar, interval)  tooltip HTML
//   line                 optional, true for lines instead of bars
//   zoomed()             optional, true to fit the y axis of bars to their min and max instead of
//                        starting at 0 (checked on every draw)
//   yLabel(v, step)      optional y tick label
// Returns { update(buckets) }, which redraws the chart with other buckets (same layout), and
// { redraw() }.
export function initBarChart(select, el, buckets, period, chart) {
  chart = { yLabel: tickLabel, ...chart };

  const counts = INTERVALS.map(([, ms]) => barCount(period, ms));
  const auto = INTERVALS.find((_, i) => counts[i] <= AUTO_TARGET_BARS) ?? INTERVALS.at(-1);
  select.innerHTML = `<option value="auto">Auto (${auto[0]})</option>` +
    INTERVALS.map(([label, ms], i) =>
      `<option value="${ms}"${counts[i] > MAX_BARS ? " disabled" : ""}>${label}</option>`).join("");

  const stored = readStored(chart.storeKey);
  const usable = [...select.options].some(o => o.value === stored && !o.disabled);
  select.value = usable ? stored : "auto";

  const draw = () => {
    const interval = select.value === "auto" ? auto[1] : Number(select.value);
    const bars = aggregate(buckets, period, interval, chart.last).map(({ t, sums }) => chart.toBar(t, sums));
    render(el, bars, interval, period, chart);
  };
  select.addEventListener("change", () => {
    store(chart.storeKey, select.value);
    draw();
  });
  // Also draws the chart the first time, once the element has a width.
  new ResizeObserver(draw).observe(el);
  return {
    update(newBuckets) {
      buckets = newBuckets;
      draw();
    },
    redraw: draw,
  };
}
