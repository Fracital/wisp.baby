// End-to-end in a real browser: headless Chrome loads the page from dev/serve.py, with ?wisp=
// pointing at a real holyWisp on loopback that has its WebTransport listener on, and runs the whole
// test (G-Core mode, the dev speed endpoint). Node has no WebTransport, so this is where the page's
// WebTransport path runs for real. Skipped unless HOLYWISP_BIN is a holyWisp with WebTransport
// (a local build: the npm 0.5.2 one has none) and a Chrome or Chromium is found (CHROME, or on PATH).
//
//   HOLYWISP_BIN=~/src/holyWisp/build/release/holywisp node --test test/browser.test.mjs
//
// Cases: auto (must run over WebTransport), ?transport=ws (WebSocket), and auto against a listener
// that does not answer (falls back to WebSocket and says why). Each full run fails on any console
// error, uncaught exception or CSP violation. E2E_SCREENSHOTS=<dir> also saves the finished page at
// phone width in light and dark. Chrome drives over the DevTools protocol (Node's own WebSocket).
// Everything is on 127.0.0.1.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, startHolyWisp } from "./holywisp.mjs";

const BIN = process.env.HOLYWISP_BIN;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME =
  process.env.CHROME ||
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .flatMap((c) => (process.env.PATH || "").split(":").map((d) => path.join(d, c)))
    .find((p) => fs.existsSync(p));
const SHOTS = process.env.E2E_SCREENSHOTS;

function hasWebTransport(bin) {
  try {
    return /^\s*webtransport\s/m.test(execFileSync(bin, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return false;
  }
}

const skip = !BIN ? "set HOLYWISP_BIN" : !CHROME ? "no Chrome (set CHROME)" : !hasWebTransport(BIN) ? "HOLYWISP_BIN has no WebTransport" : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The DevTools protocol on one page target. */
class Cdp {
  static async open(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    const c = new Cdp(new WebSocket(page.webSocketDebuggerUrl));
    await new Promise((ok, err) => {
      c.ws.onopen = ok;
      c.ws.onerror = err;
    });
    return c;
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { ok, err } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) err(new Error(m.error.message));
        else ok(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m.method, m.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, err) => this.pending.set(id, { ok, err }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

// What the page shows (app.js draws only these elements; the engine's numbers are in them).
const READ_PAGE = `(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  return JSON.stringify({
    state: document.body.dataset.state,
    phase: document.body.dataset.phase,
    down: t("speed-value") + " " + t("speed-units"),
    up: t("up-value") + " " + t("up-units"),
    upDone: document.getElementById("up-cell").dataset.measuring === "false",
    unloaded: t("lat-unloaded"),
    loaded: t("lat-loaded"),
    mbDown: t("data-down"),
    mbUp: t("data-up"),
    via: document.getElementById("route-via").hidden ? null : t("route-via"),
    transport: t("fact-transport"),
    error: document.getElementById("error").hidden ? null : t("error-msg"),
  });
})()`;

test("the page in headless Chrome against holyWisp with WebTransport", { skip, timeout: 300000 }, async (t) => {
  const children = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wispbaby-chrome-"));
  t.after(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  });

  const wispPort = await freePort();
  children.push(await startHolyWisp(BIN, wispPort, ["--webtransport", "on"]));
  const sitePort = await freePort();
  const speedPort = await freePort();
  const serve = spawn("python3", [path.join(ROOT, "dev/serve.py"), "--port", String(sitePort), "--speed-port", String(speedPort)], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(serve);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${sitePort}/where`)).ok, 10000, "dev/serve.py");
  const wtJson = await (await fetch(`http://127.0.0.1:${wispPort}/webtransport.json`)).json();
  assert.ok(wtJson.hashes.length >= 1, "a self-signed listener lists its certificate hash");

  const chrome = spawn(
    CHROME,
    ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  children.push(chrome);
  const devPort = await waitFor(() => {
    const f = path.join(profile, "DevToolsActivePort");
    return fs.existsSync(f) && Number(fs.readFileSync(f, "utf8").split("\n")[0]);
  }, 20000, "Chrome's DevTools port");
  const cdp = await Cdp.open(devPort);
  t.after(() => cdp.close());

  let problems = [];
  cdp.on((method, p) => {
    if (method === "Runtime.exceptionThrown") problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    if (method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) {
      problems.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    // Chrome asks for /favicon.ico on its own while it shows the bare SVG used to set storage.
    if (method === "Log.entryAdded" && p.entry.level === "error" && !/\/favicon\.ico$/.test(p.entry.url || "")) {
      problems.push(`log (${p.entry.source}): ${p.entry.text} ${p.entry.url || ""}`);
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  const origin = `http://127.0.0.1:${sitePort}`;
  const wispUrl = `ws://127.0.0.1:${wispPort}/`;
  // Short runs: duration 5 to 10 s. Set on the origin before the page loads (it starts at once).
  await cdp.send("Page.navigate", { url: `${origin}/favicon.svg` });
  await waitFor(async () => (await cdp.eval("location.pathname")) === "/favicon.svg", 10000, "the origin");
  const settings = { connMin: 1, connMax: 8, durMin: 5, durMax: 10, showAll: true, transport: "auto" };
  await cdp.eval(`localStorage.clear(); localStorage.setItem("wispbaby.settings", ${JSON.stringify(JSON.stringify(settings))}); true`);

  async function runPage(query, { until = "done", ms = 120000 } = {}) {
    problems = [];
    await cdp.send("Page.navigate", { url: `${origin}/?wisp=${encodeURIComponent(wispUrl)}${query}#gcore` });
    const t0 = Date.now();
    const page = await waitFor(async () => {
      const s = JSON.parse(await cdp.eval(READ_PAGE));
      if (s.error) return s;
      if (until === "transport" && s.via) return s;
      if (until === "done" && s.upDone && s.phase === "idle") return s;
      return null;
    }, ms, `the page (${query || "auto"})`);
    page.seconds = ((Date.now() - t0) / 1000).toFixed(1);
    return page;
  }

  async function screenshots(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(300);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, `${name}-${scheme}.png`), Buffer.from(data, "base64"));
      const overflow = await cdp.eval("document.documentElement.scrollWidth > window.innerWidth");
      assert.equal(overflow, false, `no horizontal scroll at phone width (${scheme})`);
    }
    // The settings form, with the transport choice, at phone width.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await cdp.eval(`document.getElementById("settings-btn").click(); document.getElementById("settings").scrollIntoView(); true`);
    await sleep(300);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}-settings.png`), Buffer.from(data, "base64"));
    assert.equal(await cdp.eval("document.documentElement.scrollWidth > window.innerWidth"), false, "settings fit at 360 px");
    assert.equal(await cdp.eval(`document.querySelector("#settings select[name=transport]").value`), "auto");
    await cdp.eval(`document.getElementById("settings-cancel").click(); true`);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }

  const num = (s) => parseFloat(s);

  await t.test("auto: the whole test over WebTransport", async () => {
    const p = await runPage("");
    t.diagnostic(`auto: ${JSON.stringify(p)}`);
    assert.equal(p.error, null);
    assert.deepEqual(problems, []);
    assert.equal(p.via, "· via WebTransport (QUIC)");
    assert.match(p.transport, new RegExp(`^WebTransport \\(QUIC\\) to https://127\\.0\\.0\\.1:${wispPort}/$`));
    assert.ok(num(p.down) > 0 && num(p.up) > 0, "download and upload speeds");
    assert.ok(num(p.mbDown) > 0 && num(p.mbUp) > 0, "data used");
    assert.ok(Number.isFinite(num(p.unloaded)) && Number.isFinite(num(p.loaded)), "latencies");
    await screenshots("webtransport");
  });

  await t.test("?transport=ws: the whole test over WebSocket", async () => {
    const p = await runPage("&transport=ws");
    t.diagnostic(`websocket: ${JSON.stringify(p)}`);
    assert.equal(p.error, null);
    assert.deepEqual(problems, []);
    assert.equal(p.via, "· via WebSocket");
    assert.equal(p.transport, `WebSocket to ${wispUrl}`);
    assert.ok(num(p.down) > 0 && num(p.up) > 0);
  });

  await t.test("auto, the listener does not answer: WebSocket, and why", async () => {
    // A holyWisp whose /webtransport.json names a UDP port nobody listens on.
    const deadPort = await freePort();
    const port2 = await freePort();
    children.push(
      await startHolyWisp(BIN, port2, ["--webtransport", "on", "--webtransport-port", String(await freePort()), "--webtransport-url", `https://127.0.0.1:${deadPort}/`]),
    );
    const url2 = `ws://127.0.0.1:${port2}/`;
    problems = [];
    await cdp.send("Page.navigate", { url: `${origin}/?wisp=${encodeURIComponent(url2)}#gcore` });
    const p = await waitFor(async () => {
      const s = JSON.parse(await cdp.eval(READ_PAGE));
      return s.error || (s.via && s.phase === "download") ? s : null;
    }, 30000, "the fallback");
    t.diagnostic(`fallback: ${JSON.stringify(p)}`);
    assert.equal(p.error, null);
    assert.equal(p.via, "· via WebSocket");
    assert.match(p.transport, new RegExp(`^WebSocket to ws://127\\.0\\.0\\.1:${port2}/ \\(WebTransport did not open: .+\\)$`));
    // Chrome logs the failed handshake to the dead port itself; nothing else may be wrong.
    assert.deepEqual(problems.filter((m) => !m.includes(`https://127.0.0.1:${deadPort}/`) && !/WebTransport/.test(m)), []);
    // Remembered: the next auto run does not wait for it again.
    const q = await waitFor(async () => {
      await cdp.send("Page.reload", { ignoreCache: true });  // the same URL again would only be a fragment change
      await sleep(1500);
      const s = JSON.parse(await cdp.eval(READ_PAGE));
      return s.via ? s : null;
    }, 20000, "the second run");
    assert.match(q.transport, /\(WebTransport failed here recently\)$/);
    await cdp.send("Page.navigate", { url: "about:blank" });
  });
});
