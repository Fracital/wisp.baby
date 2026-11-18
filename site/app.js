// wisp.baby UI. The engine (speedtest.js) does the measuring; this file only
// drives it and draws what it reports. Contract: README.md.
import { createSpeedtest } from "./speedtest.js";
import * as ls from "./livestats.js";

const LIBCURL_BASE = "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.4/";
const MODES = ["gcore", "netflix"];
const KEY_MODE = "wispbaby.mode";
const KEY_SETTINGS = "wispbaby.settings";
const DEFAULTS = Object.freeze({ connMin: 1, connMax: 8, durMin: 5, durMax: 30, showAll: false });

const $ = (id) => document.getElementById(id);
const body = document.body;

// ---------- storage (every access may throw: private mode, blocked site data) ----------

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not persisted, fine */ }
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(load(KEY_SETTINGS) || "{}") || {}; } catch { s = {}; }
  const out = { ...DEFAULTS };
  for (const k of ["connMin", "connMax", "durMin", "durMax"]) {
    if (Number.isInteger(s[k])) out[k] = s[k];
  }
  out.showAll = s.showAll === true;
  return validSettings(out) ? out : { ...DEFAULTS };
}

function validSettings(s) {
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  return inRange(s.connMin, 1, 8) && inRange(s.connMax, 1, 8) && s.connMin <= s.connMax
    && inRange(s.durMin, 5, 30) && inRange(s.durMax, 5, 30) && s.durMin <= s.durMax;
}

// ---------- formatting (README "Display") ----------

function round(v) {
  if (v < 9.95) return v.toFixed(1);
  if (v < 100) return String(Math.round(v));
  return String(Math.round(v / 10) * 10);
}

function fmtSpeed(bps) {
  const mbps = (Number(bps) || 0) / 1e6;
  if (mbps < 1) return { value: round(mbps * 1000), units: "Kbps" };
  if (mbps >= 995) return { value: round(mbps / 1000), units: "Gbps" };
  return { value: round(mbps), units: "Mbps" };
}

function fmtMB(bytes) {
  const mb = (Number(bytes) || 0) / 1e6;
  if (mb < 1) return mb.toFixed(2);
  if (mb < 10) return mb.toFixed(1);
  return String(Math.round(mb / 10) * 10);
}

// Sub-10 ms gets one decimal (a box next door answers in under a millisecond).
const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 10) return ms.toFixed(1);
  return String(Math.round(ms));
};

// ---------- page parameters ----------

const params = new URLSearchParams(location.search);
// ?wisp=<url> and ?where=<url> are dev overrides (dev/serve.py, local mocks).
const wispUrl = params.get("wisp") || `wss://${location.host}/`;
const whereUrl = params.get("where") || "/where";

let settings = loadSettings();
let mode = modeFromHash() || (MODES.includes(load(KEY_MODE)) ? load(KEY_MODE) : "gcore");
let where = null;
let test = null;       // the running engine
let run = 0;           // bumps on every start, so a stopped engine's late events are ignored
let state = {};

function modeFromHash() {
  const h = location.hash.replace(/^#/, "").toLowerCase();
  return MODES.includes(h) ? h : null;
}

// ---------- drawing ----------

const PHASE_TEXT = {
  servers: "Finding servers",
  download: "Measuring download",
  latency: "Measuring latency",
  upload: "Measuring upload",
};
const MODE_TEXT = {
  gcore: "The wisp box is the test server",
  netflix: "Netflix's servers, reached from the wisp box",
};

function setPhase(phase) {
  body.dataset.phase = phase;
  const p = PHASE_TEXT[phase];
  $("route-caption").textContent = MODE_TEXT[mode] + (p ? `. ${p}` : "");
}

function setSpeed(bps) {
  const { value, units } = fmtSpeed(bps);
  $("speed-value").textContent = value;
  $("speed-units").textContent = units;
}

function setMeasuring(cellId, on) {
  $(cellId).dataset.measuring = on ? "true" : "false";
}

function drawMode() {
  body.dataset.mode = mode;
  for (const btn of document.querySelectorAll(".switch-opt")) {
    const on = btn.dataset.mode === mode;
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
  }
  setPhase(body.dataset.phase || "idle");
}

function drawWhere() {
  const host = where?.host || location.hostname || "wisp.baby";
  $("route-box").textContent = host;
  $("relay-url").textContent = wispUrl;
  drawWisp(where);
}

function drawWisp(w) {
  if (!w) { $("fact-wisp").textContent = "…"; return; }
  const place = [w.city, w.country].filter(Boolean).join(", ");
  const parts = place && w.host ? `${w.host} in ${place}` : place || w.host;
  $("fact-wisp").textContent = w.addr ? `${parts} (${w.addr})` : parts || "…";
}

function drawTargets(targets) {
  const dd = $("fact-targets");
  dd.replaceChildren();
  if (!Array.isArray(targets) || targets.length === 0) { dd.textContent = "…"; return; }
  targets.forEach((t, i) => {
    if (i) dd.append(", ");
    const label = t.label && t.label !== t.addr ? `${t.label} ` : "";
    dd.append(label);
    if (t.addr) {
      const code = document.createElement("code");
      code.textContent = t.addr;
      dd.append(label ? "(" : "", code, label ? ")" : "");
    }
  });
  if (mode === "gcore") dd.prepend("the same box: ");
}

function resetView() {
  state = { downloadDone: false, downBytes: 0, upBytes: 0 };
  body.dataset.state = "measuring";
  $("speed").setAttribute("aria-busy", "true");
  $("speed-value").textContent = "0";
  $("speed-units").textContent = "Mbps";
  $("restart").hidden = true;
  $("error").hidden = true;
  $("lat-unloaded").textContent = "–";
  $("lat-loaded").textContent = "–";
  $("up-value").textContent = "–";
  $("up-units").textContent = "Mbps";
  $("up-status").textContent = "Waiting for the download";
  setMeasuring("lat-unloaded-cell", true);
  setMeasuring("lat-loaded-cell", true);
  setMeasuring("up-cell", true);
  $("data-down").textContent = "0";
  $("data-up").textContent = "0";
  drawTargets(null);
  drawWisp(where);
  document.title = "wisp.baby: internet speed test over Wisp";
  setPhase("servers");
}

function showError(message, phase) {
  const what = { servers: "Couldn't reach the test servers", download: "The download test failed",
    latency: "The latency test failed", upload: "The upload test failed" }[phase] || "The test failed";
  let detail = String(message || "").replace(/\s+/g, " ").trim();
  if (detail.length > 140) detail = detail.slice(0, 137) + "…";
  $("error-msg").textContent = detail ? `${what}: ${detail}` : `${what}.`;
  $("error").hidden = false;
  $("speed").setAttribute("aria-busy", "false");
  if (!state.downloadDone) {
    body.dataset.state = "error";
  } else {
    // The download result stands; mark what didn't finish.
    if ($("lat-unloaded-cell").dataset.measuring === "true") $("lat-unloaded").textContent = "–";
    if ($("up-cell").dataset.measuring === "true") $("up-status").textContent = "Didn't finish";
  }
  setPhase("idle");
}

// ---------- the test ----------

async function start() {
  stop();
  const my = ++run;
  resetView();

  if (!where) {
    try {
      const res = await fetch(whereUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      where = await res.json();
    } catch (e) {
      if (my !== run) return;
      showError(e?.message, "servers");
      return;
    }
    if (my !== run) return;
    drawWhere();
  }

  let t;
  try {
    t = createSpeedtest({
      mode,
      wispUrl,
      // speedPort: the box's speed-test port (80 on the boxes; dev/serve.py uses another).
      where: { site: where.site, host: where.host, city: where.city, country: where.country, addr: where.addr,
        speedPort: where.speedPort },
      connections: { min: settings.connMin, max: settings.connMax },
      duration: { min: settings.durMin, max: settings.durMax },
      libcurlBase: LIBCURL_BASE,
    });
  } catch (e) {
    showError(e?.message, "servers");
    return;
  }
  test = t;
  const on = (ev, fn) => t.on(ev, (d) => { if (my === run && test === t) fn(d || {}); });

  on("phase", ({ phase }) => {
    if (phase === "done") { setPhase("idle"); test = null; refreshYouSoon(); return; }
    setPhase(phase);
    if (phase === "upload") $("up-status").textContent = "Measuring…";
    if (phase === "latency") $("up-status").textContent = "Up next";
  });

  on("servers", ({ wisp, targets }) => {
    if (wisp) drawWisp({ ...where, ...wisp });
    drawTargets(targets);
  });

  on("download", ({ speedBps, bytes, loadedLatencyMs, final }) => {
    if (state.downloadDone) return;
    setSpeed(speedBps);
    if (Number.isFinite(bytes)) { state.downBytes = bytes; $("data-down").textContent = fmtMB(bytes); }
    if (Number.isFinite(loadedLatencyMs)) $("lat-loaded").textContent = fmtMs(loadedLatencyMs);
    if (final) {
      state.downloadDone = true;
      body.dataset.state = "done";
      $("speed").setAttribute("aria-busy", "false");
      $("restart").hidden = false;
      setMeasuring("lat-loaded-cell", false);
      const { value, units } = fmtSpeed(speedBps);
      document.title = `wisp.baby: ${value} ${units}`;
    }
  });

  on("latency", ({ unloadedMs, final }) => {
    if (Number.isFinite(unloadedMs)) $("lat-unloaded").textContent = fmtMs(unloadedMs);
    if (final) setMeasuring("lat-unloaded-cell", false);
  });

  on("upload", ({ speedBps, bytes, final }) => {
    const { value, units } = fmtSpeed(speedBps);
    $("up-value").textContent = value;
    $("up-units").textContent = units;
    if (Number.isFinite(bytes)) { state.upBytes = bytes; $("data-up").textContent = fmtMB(bytes); }
    if (final) { setMeasuring("up-cell", false); $("up-status").textContent = ""; }
  });

  on("error", ({ message, phase }) => {
    showError(message, phase);
    stop();
  });

  try {
    t.start();
  } catch (e) {
    showError(e?.message, "servers");
    stop();
  }
}

function stop() {
  const t = test;
  test = null;
  if (!t) return;
  try {
    const p = t.stop();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* already stopped */ }
}

// ---------- mode switch ----------

function setMode(next, { fromHash = false } = {}) {
  if (!MODES.includes(next) || next === mode) return;
  mode = next;
  save(KEY_MODE, mode);
  if (!fromHash) {
    try { history.replaceState(null, "", `#${mode}`); } catch { location.hash = mode; }
  }
  const sw = $("switch");
  sw.classList.remove("moving");
  void sw.offsetWidth; // restart the stretch animation
  sw.classList.add("moving");
  setTimeout(() => sw.classList.remove("moving"), 600);
  drawMode();
  start();
}

// A click anywhere on the switch, the selected side included, flips it to the next mode,
// like a toggle. The arrow keys below still pick a side directly.
$("switch").addEventListener("click", () => {
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  setMode(next);
  $(`opt-${next}`).focus({ preventScroll: true });
});

$("switch").addEventListener("keydown", (e) => {
  const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  if (!(e.key in keys) && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  let i = MODES.indexOf(mode);
  if (e.key === "Home") i = 0;
  else if (e.key === "End") i = MODES.length - 1;
  else i = (i + keys[e.key] + MODES.length) % MODES.length;
  setMode(MODES[i]);
  $(`opt-${MODES[i]}`).focus();
});

addEventListener("hashchange", () => {
  const m = modeFromHash();
  if (m) setMode(m, { fromHash: true });
});

// ---------- more info and settings ----------

function setMore(open) {
  $("more").hidden = !open;
  $("more-btn").setAttribute("aria-expanded", open ? "true" : "false");
  $("more-btn").textContent = open ? "Show less info" : "Show more info";
  if (!open) setSettings(false);
}

$("more-btn").addEventListener("click", () => setMore($("more").hidden));

const form = $("settings");

function setSettings(open) {
  form.hidden = !open;
  $("settings-btn").setAttribute("aria-expanded", open ? "true" : "false");
  $("settings-err").hidden = true;
  if (open) {
    form.connMin.value = settings.connMin;
    form.connMax.value = settings.connMax;
    form.durMin.value = settings.durMin;
    form.durMax.value = settings.durMax;
    form.showAll.checked = settings.showAll;
    form.connMin.focus();
  }
}

$("settings-btn").addEventListener("click", () => setSettings(form.hidden));
$("settings-cancel").addEventListener("click", () => { setSettings(false); $("settings-btn").focus(); });

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const num = (el) => (/^\s*\d+\s*$/.test(el.value) ? Number(el.value) : NaN);
  const next = {
    connMin: num(form.connMin), connMax: num(form.connMax),
    durMin: num(form.durMin), durMax: num(form.durMax),
    showAll: form.showAll.checked,
  };
  if (!validSettings(next)) {
    const err = $("settings-err");
    err.textContent = "Connections must be 1 to 8 and duration 5 to 30 seconds, with min no more than max.";
    err.hidden = false;
    return;
  }
  const changed = ["connMin", "connMax", "durMin", "durMax"].some((k) => next[k] !== settings[k]);
  settings = next;
  save(KEY_SETTINGS, JSON.stringify(settings));
  setSettings(false);
  $("settings-btn").focus();
  if (changed) start();
});

// ---------- restart, retry, boot ----------

$("restart").addEventListener("click", () => start());
$("retry").addEventListener("click", () => start());

if (location.hash && !modeFromHash()) { /* foreign hash: leave it */ }
else {
  try { history.replaceState(null, "", `${location.pathname}${location.search}#${mode}`); } catch { /* ignore */ }
}

// ---------- live stats (README.md "Live stats"; the maths is livestats.js) ----------

const KEY_VIEW = "wispbaby.liveView";
const KEY_SPLIT = "wispbaby.liveSplit";
const SPLITS = ["box", "domain"];
const LIVE_EVERY = 2000;          // /live
const YOU_EVERY = 15000;          // /you
const HISTORY_EVERY = 60000;      // /live/history, while a long view is showing
const SVG_NS = "http://www.w3.org/2000/svg";
const reducedMotion = (() => {
  try { return matchMedia("(prefers-reduced-motion: reduce)"); } catch { return { matches: false }; }
})();

const lv = {
  data: null,           // last /live
  you: null,            // last /you
  // The graph's series per split: site names, or domain keys, in /live order. The colour follows
  // the series: its index here ("other" is always grey).
  keys: { box: [], domain: [] },
  labels: {},           // domain key -> the collector's label
  windows: { box: { m10: null, h24: null, d7: null }, domain: { m10: null, h24: null, d7: null } },
  view: ls.VIEWS[load(KEY_VIEW)] ? load(KEY_VIEW) : "m10",
  split: SPLITS.includes(load(KEY_SPLIT)) ? load(KEY_SPLIT) : "box",
  timers: { live: 0, you: 0, history: 0 },
  historyAt: 0,
  failures: 0,
  hover: null,          // slot index under the pointer, or null
  geom: null,           // last drawn geometry, for the hover layer
  hiddenAt: 0,          // when the tab was hidden, 0 while it shows
};

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const timeFmt = {};
function fmtTime(t, kind) {
  const opts = {
    tick: { hour: "2-digit", minute: "2-digit" },
    day: { weekday: "short" },
    m10: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
    h24: { hour: "2-digit", minute: "2-digit" },
    d7: { weekday: "short", hour: "2-digit", minute: "2-digit" },
  }[kind];
  try {
    timeFmt[kind] ||= new Intl.DateTimeFormat(undefined, opts);
    return timeFmt[kind].format(new Date(t));
  } catch { return new Date(t).toISOString().slice(11, 16); }
}

function setText(id, text) {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function rateText(bps) {
  const { value, units } = ls.fmtRate(bps);
  return `${value} ${units}`;
}
function bytesText(b) {
  const { value, units } = ls.fmtBytes(b);
  return `${value} ${units}`;
}

// ---------- polling ----------

function hiddenTab() {
  // Also true once the panel is hidden for good (a box without stats): nothing polls then.
  return document.visibilityState === "hidden" || $("live").hidden;
}

async function pollLive() {
  clearTimeout(lv.timers.live);
  if (hiddenTab()) return;
  try {
    const d = await getJson("/live");
    lv.failures = 0;
    onLive(d);
  } catch (e) {
    // 404: this box serves no stats (not set up yet). Hide the panel and stop asking.
    if (e?.status === 404 && !lv.data) {
      $("live").hidden = true;
      clearTimeout(lv.timers.you);
      return;
    }
    lv.failures++;
    if (lv.failures >= 2) {
      $("live").dataset.state = "offline";
      setText("live-now-sub", "the stats can't be reached right now, retrying");
    }
  }
  // Back off while the stats are down: 2 s, 4 s, … up to 30 s.
  const wait = Math.min(30000, LIVE_EVERY * 2 ** Math.max(0, lv.failures - 1));
  lv.timers.live = setTimeout(pollLive, wait);
}

async function pollYou() {
  clearTimeout(lv.timers.you);
  if (hiddenTab()) return;
  try { drawYou(await getJson("/you")); } catch { /* keep the last numbers */ }
  lv.timers.you = setTimeout(pollYou, YOU_EVERY);
}

// After a speed test the visitor's own traffic just moved: show it.
function refreshYouSoon() {
  clearTimeout(lv.timers.you);
  lv.timers.you = setTimeout(pollYou, 1500);
}

async function pollHistory(force = false) {
  clearTimeout(lv.timers.history);
  if (hiddenTab()) return;
  if (force || Date.now() - lv.historyAt > HISTORY_EVERY - 1000) {
    try {
      onHistory(await getJson("/live/history"));
      lv.historyAt = Date.now();
    } catch { /* the 10 min view still fills from /live */ }
  }
  if (lv.view !== "m10") lv.timers.history = setTimeout(pollHistory, HISTORY_EVERY);
}

function startLive() {
  drawTabs();
  drawSplit();
  sizeChart();
  pollHistory(true).then(() => pollLive());
  pollYou();
  document.addEventListener("visibilitychange", () => {
    if (hiddenTab()) { lv.hiddenAt ||= Date.now(); return; }
    // Opened in a background tab (nothing fetched yet), or away long enough that the 10 min graph
    // has a gap: refill it from the history first, as on load.
    const away = lv.hiddenAt ? Date.now() - lv.hiddenAt : 0;
    lv.hiddenAt = 0;
    if (!lv.historyAt || away > 30000) {
      for (const sp of SPLITS) lv.windows[sp].m10 = null;
      pollHistory(true).then(() => pollLive());
    } else {
      pollLive();
      if (lv.view !== "m10") pollHistory();
    }
    pollYou();
  });
}

// ---------- data in ----------

const FIELD = { box: "sites", domain: "domains" };

// The split on screen: by domain only once the collector sends domains.
function split() {
  return lv.split === "domain" && lv.keys.domain.length ? "domain" : "box";
}

function ensureKeys(sp, names) {
  if (names.length && names.join() !== lv.keys[sp].join()) {
    lv.keys[sp] = names;
    // A window made for other series is rebuilt from the next data.
    const ws = lv.windows[sp];
    for (const k of Object.keys(ws)) {
      if (ws[k] && Object.keys(ws[k].values).join() !== names.join()) ws[k] = null;
    }
  }
}

function setLabels(list) {
  for (const d of list) lv.labels[d.key] = d.label;
}

function onHistory(h) {
  if (!h || h.v !== 1) return;
  if (!lv.keys.box.length) ensureKeys("box", Object.keys(h.m10?.sites || h.h24?.sites || {}));
  if (!lv.keys.domain.length && Array.isArray(h.domainLabels)) {
    const doms = ls.liveDomains({ domains: h.domainLabels });
    setLabels(doms);
    ensureKeys("domain", doms.map((d) => d.key));
  }
  for (const sp of SPLITS) {
    const keys = lv.keys[sp];
    if (!keys.length) continue;
    const ws = lv.windows[sp];
    for (const k of ["h24", "d7"]) {
      const b = ls.seriesBlock(h[k], FIELD[sp], keys);
      if (b) ws[k] = ls.windowFrom(b, ls.VIEWS[k].points, keys);
    }
    const b = !ws.m10 && ls.seriesBlock(h.m10, FIELD[sp], keys);
    if (b) ws.m10 = ls.windowFrom(b, ls.VIEWS.m10.points, keys);
  }
  drawSplit();
  if (lv.view !== "m10") drawChart(0);
}

// Slides one split's 10 min window by the /live tail; returns the slots it moved.
function mergeLive(sp, tail) {
  const keys = lv.keys[sp];
  const b = keys.length && ls.seriesBlock(tail, FIELD[sp], keys);
  if (!b) return 0;
  const ws = lv.windows[sp];
  if (!ws.m10) {
    const len = Math.max(0, ...Object.values(b.sites).map((a) => a.length));
    ws.m10 = ls.emptyWindow(b.step, ls.VIEWS.m10.points, b.t0 + (len - 1) * b.step, keys);
  }
  return ls.mergeTail(ws.m10, b);
}

function onLive(d) {
  if (!d || d.v !== 1) return;
  lv.data = d;
  const sites = ls.liveSites(d);
  const doms = ls.liveDomains(d);
  ensureKeys("box", sites.map((s) => s.site));
  setLabels(doms);
  ensureKeys("domain", doms.map((x) => x.key));
  const slid = {};
  for (const sp of SPLITS) slid[sp] = d.tail ? mergeLive(sp, d.tail) : 0;
  const age = ls.liveAge(d);
  $("live").dataset.state = d.stale || age > 15000 ? "stale" : "live";
  drawNow(d, sites);
  drawSplit();
  drawLegend();
  drawTotals(d);
  drawDomainTotals(d, doms);
  if (lv.you) drawYou(lv.you);  // the box's city comes from /live
  if (lv.view === "m10") drawChart(slid[split()]);
}

// ---------- drawing: numbers ----------

function drawNow(d, sites) {
  const total = (Number(d.now?.downBps) || 0) + (Number(d.now?.upBps) || 0);
  const { value, units } = ls.fmtRate(total);
  setText("live-rate", value);
  setText("live-rate-units", units);
  const up = sites.filter((s) => s.up).length;
  const stale = $("live").dataset.state === "stale";
  const boxes = up === sites.length ? `all ${sites.length} boxes` : `${up} of ${sites.length} boxes`;
  setText("live-now-sub", stale
    ? `last heard ${Math.round(ls.liveAge(d) / 1000)} s ago`
    : `${rateText(d.now?.downBps)} down, ${rateText(d.now?.upBps)} up, across ${boxes}`);
}

// The colour class of series i of the current split: "other" is grey, never a palette slot.
function seriesClass(key, i) {
  return split() === "domain" && key === "other" ? "so" : `s${i}`;
}

function seriesName(key) {
  return split() === "domain" ? lv.labels[key] || key : ls.siteCode(key);
}

// The chips under the graph: the boxes, or the domains, right now.
function drawLegend() {
  const d = lv.data;
  if (!d) return;
  const sp = split();
  const items = sp === "domain"
    ? ls.liveDomains(d).map((x) => ({
      key: x.key, up: true, code: x.label,
      sub: `${ls.fmtCount(x.sessionsActive)} open`, rate: rateText(x.bps),
    }))
    : ls.liveSites(d).map((s) => ({
      key: s.site, up: s.up, code: ls.siteCode(s.site),
      sub: s.city || s.site, rate: s.up ? rateText(s.bps) : "offline",
    }));
  const ul = $("sites");
  ul.setAttribute("aria-label", sp === "domain" ? "Traffic by domain, right now" : "The boxes, right now");
  ul.style.setProperty("--n", String(Math.max(1, items.length)));
  if (ul.children.length !== items.length || ul.dataset.split !== sp) {
    ul.dataset.split = sp;
    ul.replaceChildren(...items.map((it, i) => {
      const li = document.createElement("li");
      li.className = `site ${seriesClass(it.key, i)}`;
      const sw = document.createElement("span");
      sw.className = "site-swatch";
      sw.setAttribute("aria-hidden", "true");
      const code = document.createElement("span");
      code.className = "site-code";
      const city = document.createElement("span");
      city.className = "site-city";
      const rate = document.createElement("span");
      rate.className = "site-rate";
      li.append(sw, code, city, rate);
      return li;
    }));
  }
  items.forEach((it, i) => {
    const li = ul.children[i];
    li.dataset.up = it.up ? "true" : "false";
    li.children[1].textContent = it.code;
    li.children[1].title = it.code;
    li.children[2].textContent = it.sub;
    li.children[3].textContent = it.rate;
  });
}

// The by-domain rows of the Everyone panel: open now, then data moved over 5 h, 30 d and all time.
function drawDomainTotals(d, doms) {
  const box = $("dom-totals");
  if (!doms.length) { box.hidden = true; return; }
  box.hidden = false;
  const totals = ls.domainTotals(d, doms.map((x) => x.key));
  const body = $("dom-rows");
  if (body.children.length !== doms.length || body.dataset.keys !== doms.map((x) => x.key).join()) {
    body.dataset.keys = doms.map((x) => x.key).join();
    body.replaceChildren(...doms.map((x, i) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      const sw = document.createElement("span");
      sw.className = `dom-swatch ${x.key === "other" ? "so" : `s${i}`}`;
      sw.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      th.append(sw, name);
      tr.append(th, ...[0, 1, 2, 3].map(() => document.createElement("td")));
      return tr;
    }));
  }
  doms.forEach((x, i) => {
    const tr = body.children[i];
    tr.firstChild.lastChild.textContent = x.label;
    const t = totals[x.key];
    const cells = [ls.fmtCount(x.sessionsActive), ...["h5", "d30", "all"].map((w) => (t[w] === null ? "–" : bytesText(t[w])))];
    cells.forEach((v, k) => { if (tr.children[k + 1].textContent !== v) tr.children[k + 1].textContent = v; });
  });
}

function drawTotals(d) {
  const t = d.totals || {};
  for (const k of ["h5", "d7", "d30", "all"]) {
    setText(`t-bytes-${k}`, t[k] ? bytesText(t[k].bytes) : "–");
    setText(`t-sess-${k}`, t[k] ? ls.fmtCount(t[k].sessions) : "–");
    setText(`t-st-${k}`, d.speedtest && Number.isFinite(d.speedtest[k]) ? bytesText(d.speedtest[k]) : "–");
  }
  setText("g-open", ls.fmtCount(d.now?.sessionsActive));
  setText("g-today", d.clients ? ls.fmtCount(d.clients.today) : "–");
  setText("g-d30", d.clients ? ls.fmtCount(d.clients.d30) : "–");
  setText("g-ipdays", d.clients ? ls.fmtCount(d.clients.ipDays30) : "–");
  setText("g-peak", d.peak24h?.bps ? `${rateText(d.peak24h.bps)} at ${fmtTime(d.peak24h.at, "h24")}` : "–");
  setText("g-byod", Number.isFinite(d.byodDomains) ? ls.fmtCount(d.byodDomains) : "–");
  const since = d.totals?.all?.since;
  $("t-bytes-all").title = since ? `Since ${new Date(since).toLocaleDateString()}` : "";
}

function drawYou(y) {
  if (!y || y.v !== 1) return;
  lv.you = y;
  setText("you-ip", y.ip || "–");
  setText("you-geo", [y.city, y.country].filter(Boolean).join(", ") || "Unknown");
  const site = lv.data ? ls.liveSites(lv.data).find((s) => s.site === y.site) : null;
  const city = site?.city || (where?.site === y.site ? where.city : "");
  setText("you-box", city ? `${ls.siteCode(y.site)}, ${city}` : ls.siteCode(y.site) || "–");
  setText("you-rtt", Number.isFinite(y.rttMs) ? `${ls.fmtMs(y.rttMs)} ms (TCP, measured by the box)` : "–");
  setText("you-open", ls.fmtCount(y.openSessions));
  const day = y.day || {};
  const n = Number(day.sessions) || 0;
  setText("you-day", `${bytesText(day.bytes)} in ${ls.fmtCount(n)} ${n === 1 ? "session" : "sessions"}`);
}

// ---------- drawing: the graph ----------

const CH = { left: 44, right: 8, top: 10, bottom: 24 };

function sizeChart() {
  const plot = $("chart-plot");
  const redraw = () => drawChart(0);
  try { new ResizeObserver(redraw).observe(plot); } catch { addEventListener("resize", redraw); }
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function drawChart(slid) {
  const sp = split();
  const keys = lv.keys[sp];
  const w = lv.windows[sp][lv.view];
  const svg = $("chart-svg");
  const plot = $("chart-plot");
  const width = Math.max(200, plot.clientWidth);
  const height = plot.clientHeight || 200;
  const iw = width - CH.left - CH.right;
  const ih = height - CH.top - CH.bottom;
  const hasData = w && ls.lastFilled(w) >= 0;
  $("chart-empty").hidden = !!hasData;
  if (!hasData || iw <= 0 || ih <= 0) { svg.replaceChildren(); lv.geom = null; return; }

  const g = ls.stackGeometry(w, keys, iw, ih);
  lv.geom = { w, g, keys, iw, ih, width, height };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const frag = document.createDocumentFragment();
  const defs = svgEl("defs");
  const clip = svgEl("clipPath", { id: "chart-clip" });
  clip.append(svgEl("rect", { x: 0, y: -2, width: iw, height: ih + 4 }));
  defs.append(clip);
  frag.append(defs);

  // Grid and y labels (one unit for the whole axis).
  const grid = svgEl("g", { class: "chart-grid", transform: `translate(${CH.left} ${CH.top})` });
  const yt = ls.rateTicks(g.ticks);
  g.ticks.forEach((v, i) => {
    const y = Math.round(g.y(v)) + 0.5;
    grid.append(svgEl("line", { x1: 0, x2: iw, y1: y, y2: y }));
    const label = svgEl("text", { x: -8, y, class: "chart-ylabel", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = i === g.ticks.length - 1 ? `${yt.labels[i]} ${yt.units}` : yt.labels[i];
    grid.append(label);
  });
  frag.append(grid);

  // X labels.
  const xg = svgEl("g", { class: "chart-x", transform: `translate(${CH.left} ${CH.top + ih})` });
  const ticks = ls.timeTicks(lv.view, w, (t, view) => fmtTime(t, view === "h24" ? "tick" : "day"));
  const minGap = 56;
  let lastX = -Infinity;
  for (const t of ticks) {
    const x = t.i * g.dx;
    if (x - lastX < minGap) continue;
    lastX = x;
    const anchor = x < 20 ? "start" : x > iw - 20 ? "end" : "middle";
    const label = svgEl("text", { x, y: 17, "text-anchor": anchor, class: "chart-xlabel" });
    label.textContent = t.label;
    xg.append(label);
  }
  frag.append(xg);

  // The bands, bottom to top, inside the clip. The 10 min view slides new samples in.
  const clipped = svgEl("g", { "clip-path": "url(#chart-clip)", transform: `translate(${CH.left} ${CH.top})` });
  const bands = svgEl("g", { class: "chart-bands" });
  g.bands.forEach((b, i) => {
    bands.append(svgEl("path", { d: b.area, class: `band-area ${seriesClass(keys[i], i)}` }));
  });
  g.bands.forEach((b, i) => {
    bands.append(svgEl("path", { d: b.line, class: `band-line ${seriesClass(keys[i], i)}` }));
  });
  clipped.append(bands);
  frag.append(clipped);

  // Hover layer: crosshair and a dot per band top.
  const hover = svgEl("g", { class: "chart-hover", transform: `translate(${CH.left} ${CH.top})`, visibility: "hidden" });
  hover.append(svgEl("line", { class: "chart-cross", x1: 0, x2: 0, y1: 0, y2: ih }));
  keys.forEach((k, i) => hover.append(svgEl("circle", { class: `chart-mark ${seriesClass(k, i)}`, r: 4, cx: 0, cy: 0 })));
  frag.append(hover);

  svg.replaceChildren(frag);

  if (slid > 0 && lv.view === "m10" && !reducedMotion.matches && slid < 10) {
    bands.style.transform = `translateX(${slid * g.dx}px)`;
    void bands.getBoundingClientRect();
    bands.style.transition = `transform ${LIVE_EVERY * 0.95}ms linear`;
    bands.style.transform = "translateX(0)";
  }
  if (lv.hover !== null) drawHover(lv.hover);
  drawCaption();
}

function drawCaption() {
  const w = lv.windows[split()][lv.view];
  if (!w) return;
  let peak = 0;
  for (let i = 0; i < w.points; i++) peak = Math.max(peak, ls.totalAt(w, i) || 0);
  const last = ls.lastFilled(w);
  const now = last >= 0 ? ls.totalAt(w, last) : 0;
  const span = ls.VIEWS[lv.view].label;
  setText("chart-caption", `Relay throughput by ${split()} over the last ${span}: latest ${rateText(now)}, peak ${rateText(peak)}.`);
  setText("chart-peak", peak > 0 ? `peak ${rateText(peak)}` : "");
}

function drawHover(i) {
  const gm = lv.geom;
  const tip = $("chart-tip");
  const layer = $("chart-svg").querySelector(".chart-hover");
  if (!gm || !layer || i === null) { tip.hidden = true; if (layer) layer.setAttribute("visibility", "hidden"); return; }
  const { w, g, keys } = gm;
  const total = ls.totalAt(w, i);
  if (total === null) { tip.hidden = true; layer.setAttribute("visibility", "hidden"); return; }
  const x = i * g.dx;
  layer.setAttribute("visibility", "visible");
  const cross = layer.querySelector(".chart-cross");
  cross.setAttribute("x1", x);
  cross.setAttribute("x2", x);
  let acc = 0;
  const marks = layer.querySelectorAll(".chart-mark");
  keys.forEach((s, k) => {
    const v = Number(w.values[s][i]) || 0;
    acc += v;
    marks[k].setAttribute("cx", x);
    marks[k].setAttribute("cy", g.y(acc));
    // A zero band has no top of its own: its dot would sit on the band below's.
    marks[k].setAttribute("visibility", v > 0 ? "inherit" : "hidden");
  });

  // Values lead, names follow; top band first, as the stack reads.
  const rows = keys.map((s, k) => ({ s, k, v: Number(w.values[s][i]) || 0 })).reverse();
  const head = document.createElement("p");
  head.className = "tip-head";
  const tt = document.createElement("strong");
  tt.textContent = rateText(total);
  const when = document.createElement("span");
  when.textContent = fmtTime(w.t0 + i * w.step, lv.view);
  head.append(tt, when);
  const list = document.createElement("ul");
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = seriesClass(r.s, r.k);
    const key = document.createElement("span");
    key.className = "tip-key";
    const v = document.createElement("strong");
    v.textContent = rateText(r.v);
    const name = document.createElement("span");
    name.textContent = seriesName(r.s);
    li.append(key, v, name);
    list.append(li);
  }
  tip.replaceChildren(head, list);
  tip.hidden = false;
  const px = CH.left + x;
  const tw = tip.offsetWidth;
  const left = px + 14 + tw > gm.width ? px - 14 - tw : px + 14;
  tip.style.transform = `translate(${Math.max(0, left)}px, ${CH.top}px)`;
}

{
  const plot = $("chart-plot");
  const at = (e) => {
    const gm = lv.geom;
    if (!gm) return null;
    const r = plot.getBoundingClientRect();
    const x = e.clientX - r.left - CH.left;
    if (x < -8 || x > gm.iw + 8) return null;
    return ls.slotAt(x, gm.iw, gm.w.points);
  };
  plot.addEventListener("pointermove", (e) => { lv.hover = at(e); drawHover(lv.hover); });
  plot.addEventListener("pointerleave", () => { lv.hover = null; drawHover(null); });
}

// ---------- tabs ----------

function drawTabs() {
  for (const b of document.querySelectorAll("#chart-tabs .tab")) {
    const on = b.dataset.view === lv.view;
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
  $("chart-plot").setAttribute("aria-labelledby", `tab-${lv.view}`);
}

function setView(v) {
  if (!ls.VIEWS[v] || v === lv.view) return;
  lv.view = v;
  save(KEY_VIEW, v);
  lv.hover = null;
  drawTabs();
  drawHover(null);
  drawChart(0);
  if (v !== "m10") pollHistory();
}

// By box or by domain. The switch shows once the collector sends domains.
function drawSplit() {
  const group = $("chart-split");
  group.hidden = !lv.keys.domain.length;
  const sp = split();
  for (const b of group.querySelectorAll(".tab")) b.setAttribute("aria-pressed", b.dataset.split === sp ? "true" : "false");
}

function setSplit(sp) {
  if (!SPLITS.includes(sp) || sp === split()) return;
  lv.split = sp;
  save(KEY_SPLIT, sp);
  lv.hover = null;
  drawSplit();
  drawHover(null);
  drawLegend();
  drawChart(0);
}

$("chart-split").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) setSplit(b.dataset.split);
});

$("chart-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) setView(b.dataset.view);
});
$("chart-tabs").addEventListener("keydown", (e) => {
  const order = Object.keys(ls.VIEWS);
  const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!d) return;
  e.preventDefault();
  const next = order[(order.indexOf(lv.view) + d + order.length) % order.length];
  setView(next);
  $(`tab-${next}`).focus();
});

drawMode();
drawWhere();
setMore(settings.showAll);
startLive();
start();
