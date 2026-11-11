// DOM lookup and small HTML snippets shared by the panels.

export const $ = id => document.getElementById(id);

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = value => String(value ?? "").replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

export const message = (text, error = false) =>
  `<div class="message${error ? " error" : ""}">${esc(text)}</div>`;

// `value` is HTML; escape any data inside it before passing it in.
export const stat = (label, value) =>
  `<div class="stat"><span>${esc(label)}</span><b>${value}</b></div>`;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const FIT_DIGITS = [8, 6, 4, 2, 0];

// A stat tile whose number (`x`) is rounded by fitNumbers() if it doesn't fit; the full
// value is in its tooltip.
export const fitStat = (label, x) => x == null
  ? stat(label, "–")
  : `<div class="stat"><span>${esc(label)}</span><b class="fit" data-value="${esc(x)}" title="${esc(fullNumber(x))}">` +
    `${esc(fullNumber(x))}</b></div>`;

const fullNumber = x => Number(x).toLocaleString("en-US", { maximumFractionDigits: 8 });

// Rounds the fitStat() numbers in `root` to as many decimals as fit their tile (then to the
// compact form, e.g. 8.48M), and again whenever `root` is resized.
export function fitNumbers(root) {
  const range = document.createRange();
  // The text's exact width (scrollWidth rounds away sub-pixel overflow).
  const textFits = el => {
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width <= el.getBoundingClientRect().width;
  };
  const fit = () => {
    for (const el of root.querySelectorAll("b.fit")) {
      const value = Number(el.dataset.value);
      let fits = false;
      for (const digits of FIT_DIGITS) {
        el.textContent = value.toLocaleString("en-US", { maximumFractionDigits: digits });
        if (textFits(el)) { fits = true; break; }
      }
      if (!fits) el.textContent = compact.format(value);
    }
  };
  // Only on width changes: refitting can change the height, which would retrigger the observer.
  let width = -1;
  new ResizeObserver(() => {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    fit();
  }).observe(root);
}
