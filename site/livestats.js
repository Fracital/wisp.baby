// wisp.baby live stats: the maths behind the usage panel (formatting, the series window, the
// stacked-area geometry, axis ticks). No DOM access: app.js draws, and node --test runs this as
// it is. The endpoints it reads (/live, /live/history, /you) are in README.md "Live stats".

export const VIEWS = Object.freeze({
  m10: { label: "10 min", step: 2000, points: 300 },
  h24: { label: "24 h", step: 300000, points: 288 },
  d7: { label: "7 days", step: 3600000, points: 168 },
});

// ---------- formatting ----------

function trim(v, digits) {
  return v.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

// Three significant figures at most, never trailing zeros: 1.23, 12.3, 123.
function sig3(v) {
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return trim(v, 1);
  return trim(v, 2);
}

const RATE_UNITS = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function scaled(n, units) {
  let v = Math.max(0, Number(n) || 0);
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) { v /= 1000; i++; }
  return { value: i === 0 ? String(Math.round(v)) : sig3(v), units: units[i] };
}

/** Bits per second, decimal units like the speed test: { value: "8.42", units: "Gbps" }. */
export function fmtRate(bps) { return scaled(bps, RATE_UNITS); }

/** Bytes, decimal units (the page says MB for the speed test too): { value: "5.46", units: "TB" }. */
export function fmtBytes(bytes) { return scaled(bytes, BYTE_UNITS); }

/** A count: 1,234 in full below a million, then 1.23M / 4.5B. */
export function fmtCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1e6) return v.toLocaleString("en-US");
  if (v < 1e9) return `${sig3(v / 1e6)}M`;
  return `${sig3(v / 1e9)}B`;
}

/** Milliseconds, as the speed test shows them: one decimal under 10. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "–";
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

/** "MIA" from "mia". */
export const siteCode = (site) => String(site || "").toUpperCase();

// ---------- the series window ----------

/**
 * A fixed-length window of per-site values on a regular time grid, oldest first. Values are
 * numbers (bps) or null (no data). `t0` is the time of index 0.
 */
export function emptyWindow(step, points, endT, sites) {
  const t0 = alignDown(endT, step) - (points - 1) * step;
  const values = {};
  for (const s of sites) values[s] = new Array(points).fill(null);
  return { step, points, t0, values };
}

function alignDown(t, step) { return Math.floor(t / step) * step; }

/** A window from a history block ({ step, t0, sites }), taking at most `points` from its end. */
export function windowFrom(block, points, sites) {
  const step = Number(block?.step) || 0;
  if (step <= 0) return null;
  const src = block.sites || {};
  const len = Math.max(0, ...Object.values(src).map((a) => (Array.isArray(a) ? a.length : 0)));
  const n = Math.min(points, len);
  const end = Number(block.t0) + (len - 1) * step;
  const w = emptyWindow(step, points, end, sites);
  w.t0 = end - (points - 1) * step;
  for (const s of sites) {
    const a = Array.isArray(src[s]) ? src[s] : [];
    for (let i = 0; i < n; i++) {
      const v = a[a.length - n + i];
      w.values[s][points - n + i] = Number.isFinite(v) ? v : null;
    }
  }
  return w;
}

/**
 * Merge a /live tail ({ step, t0, sites }) into a window with the same step, sliding the window
 * forward when the tail reaches past its end. Returns how many slots it slid (0 if none), so the
 * caller can animate the shift. A tail with another step is ignored.
 */
export function mergeTail(w, tail) {
  if (!w || !tail || Number(tail.step) !== w.step) return 0;
  const src = tail.sites || {};
  const len = Math.max(0, ...Object.values(src).map((a) => (Array.isArray(a) ? a.length : 0)));
  if (len === 0) return 0;
  const tailEnd = Number(tail.t0) + (len - 1) * w.step;
  const lastIdx = Math.round((tailEnd - w.t0) / w.step);
  let slid = 0;
  if (lastIdx > w.points - 1) {
    slid = lastIdx - (w.points - 1);
    for (const s of Object.keys(w.values)) {
      const a = w.values[s];
      if (slid >= w.points) a.fill(null);
      else { a.splice(0, slid); for (let i = 0; i < slid; i++) a.push(null); }
    }
    w.t0 += slid * w.step;
  }
  for (const s of Object.keys(w.values)) {
    const a = Array.isArray(src[s]) ? src[s] : [];
    for (let i = 0; i < a.length; i++) {
      const k = Math.round((Number(tail.t0) + i * w.step - w.t0) / w.step);
      if (k >= 0 && k < w.points && Number.isFinite(a[i])) w.values[s][k] = a[i];
    }
  }
  return Math.min(slid, w.points);
}

/** Index of the newest slot that has data for any site, or -1. */
export function lastFilled(w) {
  for (let i = w.points - 1; i >= 0; i--) {
    for (const s of Object.keys(w.values)) if (w.values[s][i] !== null) return i;
  }
  return -1;
}

/** Total (all sites) at slot i, or null when no site has data there. */
export function totalAt(w, i) {
  let sum = 0, any = false;
  for (const s of Object.keys(w.values)) {
    const v = w.values[s][i];
    if (v !== null && v !== undefined) { sum += v; any = true; }
  }
  return any ? sum : null;
}

// ---------- axis ----------

/** A "nice" axis maximum and its ticks (0 included) for values up to `max`, about `count` ticks. */
export function niceScale(max, count = 4) {
  const m = Number(max) > 0 ? Number(max) : 1;
  const raw = m / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  const step = nice * mag;
  const top = Math.ceil(m / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { max: top, ticks };
}

/** Rate axis labels share one unit, the one the top tick needs: ["0", "2", "4"], "Gbps". */
export function rateTicks(ticks) {
  const top = ticks[ticks.length - 1] || 0;
  const { units } = fmtRate(top);
  const div = 1000 ** RATE_UNITS.indexOf(units);
  return { units, labels: ticks.map((t) => sig3(t / div)) };
}

/**
 * X-axis ticks for a view: [{ i, label }]. 10 min: fixed relative labels. 24 h: every 6 hours of
 * local time. 7 days: each local midnight. `fmt(t, view)` makes the label (app.js, local time).
 */
export function timeTicks(view, w, fmt) {
  if (view === "m10") {
    return [{ i: 0, label: "10 min ago" }, { i: Math.floor(w.points / 2), label: "5 min ago" },
      { i: w.points - 1, label: "now" }];
  }
  const out = [];
  for (let i = 0; i < w.points; i++) {
    const d = new Date(w.t0 + i * w.step);
    const hit = view === "h24" ? d.getMinutes() === 0 && d.getHours() % 6 === 0 : d.getHours() === 0;
    if (hit) out.push({ i, label: fmt(d.getTime(), view) });
  }
  return out;
}

// ---------- stacked area geometry ----------

/**
 * Paths for a stacked area chart of the window, `sites` bottom to top, in a width × height box
 * (y down). Returns { yMax, ticks, dx, y, from, bands: [{ site, area, line }] }: `area` is a
 * closed path between the band's floor and top, `line` its top edge. Drawing starts at `from`, the
 * first slot with data; after it, a slot with no data counts as 0.
 */
export function stackGeometry(w, sites, width, height, { minMax = 1e6 } = {}) {
  const n = w.points;
  let peak = 0;
  let first = -1;
  for (let i = 0; i < n; i++) {
    const t = totalAt(w, i);
    if (t !== null && first < 0) first = i;
    peak = Math.max(peak, t || 0);
  }
  // Slots before the first sample are left empty rather than drawn as zero.
  const from = Math.max(0, first);
  const { max, ticks } = niceScale(Math.max(peak, minMax));
  const dx = n > 1 ? width / (n - 1) : width;
  const x = (i) => i * dx;
  const y = (v) => height - (v / max) * height;
  const floor = new Array(n).fill(0);
  const bands = [];
  const f = (v) => (Math.round(v * 10) / 10).toString();
  for (const s of sites) {
    const vals = w.values[s] || [];
    const top = floor.map((b, i) => b + (Number(vals[i]) || 0));
    let line = "";
    for (let i = from; i < n; i++) line += `${i > from ? "L" : "M"}${f(x(i))} ${f(y(top[i]))}`;
    let back = "";
    for (let i = n - 1; i >= from; i--) back += `L${f(x(i))} ${f(y(floor[i]))}`;
    bands.push({ site: s, area: `${line}${back}Z`, line });
    for (let i = 0; i < n; i++) floor[i] = top[i];
  }
  return { yMax: max, ticks, dx, bands, y, from };
}

/** The slot under an x position in a width-wide plot of n slots. */
export function slotAt(px, width, n) {
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((px / width) * (n - 1))));
}

// ---------- /live payload checks ----------

/** The sites of a /live payload in its order, with only the fields the page uses. */
export function liveSites(live) {
  if (!Array.isArray(live?.sites)) return [];
  return live.sites
    .filter((s) => s && typeof s.site === "string" && /^[a-z0-9-]{1,16}$/.test(s.site))
    .map((s) => ({
      site: s.site,
      city: typeof s.city === "string" ? s.city : "",
      country: typeof s.country === "string" ? s.country : "",
      up: s.up === true,
      bps: (Number(s.downBps) || 0) + (Number(s.upBps) || 0),
      sessionsActive: Number(s.sessionsActive) || 0,
    }));
}

/** How old the payload is, by the box's clock (served − ts), in ms; Infinity when unknown. */
export function liveAge(live) {
  const a = Number(live?.served) - Number(live?.ts);
  return Number.isFinite(a) ? Math.max(0, a) : Infinity;
}
