// wisp.baby UI. The engine (speedtest.js) does the measuring; this file only
// drives it and draws what it reports. Contract: README.md.
import { createSpeedtest } from "./speedtest.js";

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
    if (phase === "done") { setPhase("idle"); test = null; return; }
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

drawMode();
drawWhere();
setMore(settings.showAll);
start();
