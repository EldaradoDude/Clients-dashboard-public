// Number and time formatting. Times are shown and entered in the chosen time zone (UTC by
// default, see setTimeZone), always as 24-hour times.

export const num = (x, digits = 8) =>
  x == null ? "" : Number(x).toLocaleString("en-US", { maximumFractionDigits: digits });

// Number of decimal places in a price string such as "0.002441".
export const decimals = s => (String(s).split(".")[1] ?? "").length;

// An account's display name: client2-* accounts (one per exchange) are shown as CLIENT2-<venue>.
// Only the label changes; requests and URLs keep the real account name.
export const accountName = (venue, account) =>
  account.startsWith("client2-") ? `CLIENT2-${venue}` : account;

// An account as shown in the page; `a` has venue and account.
export const accountLabel = a => `${a.venue} · ${accountName(a.venue, a.account)}`;

// Splits `fees` (currency -> total) into the pair's quote and base currency (matched ignoring
// case; 0 when absent) and the other currencies: { quote, base, other: { currency: fee } }.
export function splitFees(fees, base, quote) {
  const other = {};
  let feeQuote = 0, feeBase = 0;
  const same = (a, b) => b != null && a.toUpperCase() === b.toUpperCase();
  for (const [currency, fee] of Object.entries(fees)) {
    if (same(currency, quote)) feeQuote += fee;
    else if (same(currency, base)) feeBase += fee;
    else other[currency] = (other[currency] ?? 0) + fee;
  }
  return { quote: feeQuote, base: feeBase, other };
}

// ---- time zone ----

const TZ_KEY = "clickhouse-viewer.time-zone";
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const validZone = tz => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

let timeZone = (() => {
  try {
    const stored = localStorage.getItem(TZ_KEY);
    return stored && validZone(stored) ? stored : "UTC";
  } catch { return "UTC"; }
})();
let partsFormat;

export const getTimeZone = () => timeZone;

export function setTimeZone(tz) {
  if (!validZone(tz)) return;
  timeZone = tz;
  partsFormat = null;
  try { localStorage.setItem(TZ_KEY, tz); } catch {}
}

// The time zones to offer: UTC, the browser's, then all others the browser knows.
export function timeZones() {
  const all = Intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", LOCAL_TZ, ...all])];
}

// The wall-clock fields of `ms` in the chosen zone, as numbers.
function wallClock(ms) {
  partsFormat ??= new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(partsFormat.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

// Offset of the chosen zone from UTC at `ms`, in ms (positive east of Greenwich).
export function zoneOffset(ms) {
  const w = wallClock(ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n, width = 2) => String(n).padStart(width, "0");

// "YYYY-MM-DD HH:MM:SS.mmm" in the chosen zone.
export function fmtTime(ms) {
  const w = wallClock(ms);
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
         `.${pad(((ms % 1000) + 1000) % 1000, 3)}`;
}

// ---- period inputs: <input type="date"> and a 24-hour HH:MM:SS text field ----

// { date: "YYYY-MM-DD", time: "HH:MM:SS" } for `ms` in the chosen zone.
export function toInput(ms) {
  const t = fmtTime(ms);
  return { date: t.slice(0, 10), time: t.slice(11, 19) };
}

// Epoch ms for a date and time in the chosen zone, or NaN if they are not valid.
export function fromInput(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((time ?? "").trim());
  if (!d || !t) return NaN;
  const [h, m, s] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (h > 23 || m > 59 || s > 59) return NaN;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, m, s);
  // The offset at the guessed instant, then again at the corrected one (around DST changes).
  let ms = wall - zoneOffset(wall);
  ms = wall - zoneOffset(ms);
  return ms;
}

export function fmtAge(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120e3) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 7200e3) return `${(ms / 60e3).toFixed(1)} min`;
  if (ms < 172800e3) return `${(ms / 3600e3).toFixed(1)} h`;
  return `${(ms / 86400e3).toFixed(1)} d`;
}
