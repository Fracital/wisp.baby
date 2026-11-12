// End-to-end: the engine in Node (global WebSocket) → a real holyWisp → a local /speedtest/range
// server. Skipped unless HOLYWISP_BIN points at a holyWisp binary (npm holywisp@0.5.2,
// bin/linux-x64/holywisp, checked against its npm integrity first).
//
//   HOLYWISP_BIN=/path/to/holywisp node --test test/e2e.test.mjs
//
// E2E_DURATION=min,max (seconds, default 5,10) sets the tester's duration bounds.
// E2E_NETFLIX=1 also runs netflix mode through the same holyWisp (needs internet; libcurl.js is
// loaded from node_modules/libcurl.js (npm install --no-save libcurl.js@0.7.4) through a fetch shim, hashes still checked). With it the
// process lingers about 5 minutes after the tests pass: libcurl.js's emscripten alarm() (curl's 300 s
// timeout) leaves a timer that is never cleared. Every socket is closed by then; it is only a timer.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSpeedtest } from "../site/speedtest.js";

const BIN = process.env.HOLYWISP_BIN;
const [DMIN, DMAX] = (process.env.E2E_DURATION || "5,10").split(",").map(Number);
const CAP = 26214400;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** The box's :80 contract: GET /speedtest/range/A-B → B-A+1 bytes (capped), POST → discard, 200. */
function startRangeServer() {
  const block = randomFillSync(Buffer.alloc(1 << 20));
  const stats = { get: 0, post: 0, sent: 0, received: 0, badHost: 0 };
  const server = http.createServer((req, res) => {
    const m = /^\/speedtest\/range\/(\d+)-(\d+)$/.exec(req.url.split("?")[0]);
    if (req.headers.host !== "wisp.baby") stats.badHost++;
    if (!m) {
      res.writeHead(404, { "Content-Length": 0 });
      res.end();
      return;
    }
    const len = Math.min(Number(m[2]) - Number(m[1]) + 1, CAP);
    if (req.method === "POST") {
      stats.post++;
      req.on("data", (c) => (stats.received += c.length));
      req.on("end", () => {
        res.writeHead(200, { "Content-Length": 0, "Cache-Control": "no-store" });
        res.end();
      });
      return;
    }
    stats.get++;
    res.writeHead(200, { "Content-Length": len, "Cache-Control": "no-store", "Content-Type": "application/octet-stream" });
    let left = len;
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, block.length);
        left -= n;
        stats.sent += n;
        if (!res.write(n === block.length ? block : block.subarray(0, n))) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
    res.on("close", () => (left = 0));
  });
  server.keepAliveTimeout = 30000;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, stats, port: server.address().port })));
}

async function startHolyWisp(port) {
  const args = [
    "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn",
    "--allow-tcp", "on", "--allow-udp", "off",
    "--allow-direct-ip", "on", "--allow-private", "on", "--allow-loopback", "on",
    "--enable-v2", "on", "--password-required", "off",
    "--buffer-remaining", "128", "--max-message-size", "262149", "--stream-queue-max", "67108864",
    "--flood-protection", "off", "--reputation", "off", "--serve-webclient", "off",
    "--tcp-nodelay", "on", "--stop-on-stdin-eof", "on",
  ];
  const proc = spawn(BIN, args, { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`holyWisp exited ${proc.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("holyWisp did not come up");
}

function record(t) {
  const events = [];
  for (const name of ["phase", "servers", "download", "latency", "upload", "error"]) {
    t.on(name, (d) => events.push({ name, d, at: performance.now() }));
  }
  return events;
}

const mbps = (bps) => (bps / 1e6).toFixed(1);

test("e2e against holyWisp", { skip: !BIN && "set HOLYWISP_BIN", timeout: 300000 }, async (t) => {
  const range = await startRangeServer();
  const wispPort = await freePort();
  const hw = await startHolyWisp(wispPort);
  const wispUrl = `ws://127.0.0.1:${wispPort}/`;
  const where = { site: "dev", host: "localhost", city: "Here", country: "XX", addr: "127.0.0.1", speedPort: range.port };
  t.after(() => {
    hw.kill();
    range.server.close();
    range.server.closeAllConnections();
  });

  await t.test("gcore mode: servers, download, latency, upload, done", async () => {
    const st = createSpeedtest({
      mode: "gcore",
      wispUrl,
      where,
      connections: { min: 1, max: 8 },
      duration: { min: DMIN, max: DMAX },
    });
    const events = record(st);
    const t0 = performance.now();
    const result = await st.start();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const errors = events.filter((e) => e.name === "error");
    assert.deepEqual(errors, []);
    assert.ok(result, "a result");
    assert.deepEqual(
      events.filter((e) => e.name === "phase").map((e) => e.d.phase),
      ["servers", "download", "latency", "upload", "done"],
    );
    const servers = events.find((e) => e.name === "servers").d;
    assert.deepEqual(servers.targets, [{ label: "localhost", addr: "127.0.0.1" }]);
    assert.equal(servers.wisp.addr, "127.0.0.1");
    // Each kind: progress events, then exactly one final, last.
    for (const kind of ["download", "latency", "upload"]) {
      const list = events.filter((e) => e.name === kind);
      assert.ok(list.length > 1, `${kind} progress`);
      assert.equal(list.filter((e) => e.d.final).length, 1);
      assert.equal(list[list.length - 1].d.final, true);
    }
    // Order: every download before every latency before every upload.
    const order = events.filter((e) => ["download", "latency", "upload"].includes(e.name)).map((e) => e.name);
    assert.deepEqual(order, [...order].sort((a, b) => ["download", "latency", "upload"].indexOf(a) - ["download", "latency", "upload"].indexOf(b)));
    const { download, latency, upload } = result;
    assert.ok(download.speedBps > 0 && download.bytes > 0);
    assert.ok(Number.isFinite(download.loadedLatencyMs));
    assert.ok(Number.isFinite(latency.unloadedMs) && latency.count > 50);
    assert.ok(upload.speedBps > 0 && upload.bytes > 0);
    assert.equal(range.stats.badHost, 0);
    t.diagnostic(
      `gcore: download ${mbps(download.speedBps)} Mb/s (${(download.bytes / 1e6).toFixed(0)} MB, loaded ${download.loadedLatencyMs.toFixed(2)} ms), ` +
      `unloaded ${latency.unloadedMs.toFixed(2)} ms over ${latency.count} pings, ` +
      `upload ${mbps(upload.speedBps)} Mb/s (${(upload.bytes / 1e6).toFixed(0)} MB); ${secs} s in all; ` +
      `server GETs ${range.stats.get}, POSTs ${range.stats.post}`,
    );
    const phases = events.filter((e) => e.name === "phase");
    t.diagnostic(
      "phase seconds: " +
        phases.slice(0, -1).map((e, i) => `${e.d.phase} ${((phases[i + 1].at - e.at) / 1000).toFixed(1)}`).join(", "),
    );
  });

  await t.test("stop() mid-download closes every socket and emits nothing more", async () => {
    const st = createSpeedtest({ mode: "gcore", wispUrl, where, connections: { min: 1, max: 8 }, duration: { min: DMIN, max: DMAX } });
    const events = record(st);
    const done = st.start();
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(events.some((e) => e.name === "download"), "download had started");
    const stoppedAt = performance.now();
    st.stop();
    assert.equal(await done, null);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(events.filter((e) => e.at > stoppedAt), []);
    const open = await new Promise((r) => range.server.getConnections((_, n) => r(n)));
    // holyWisp closes its TCP side once the WebSocket is gone; keep-alive sockets from the first run
    // were closed the same way.
    assert.equal(open, 0, "no TCP connections left at the range server");
  });

  await t.test("netflix mode", { skip: !process.env.E2E_NETFLIX && "set E2E_NETFLIX=1" }, async () => {
    // libcurl.js files from node_modules, served to the engine through a fetch shim.
    const dir = new URL("../node_modules/libcurl.js/", import.meta.url);
    const shim = async (url) => {
      const name = url.slice(url.lastIndexOf("/") + 1);
      return new Response(await readFile(new URL(name, dir)));
    };
    const st = createSpeedtest({
      mode: "netflix",
      wispUrl,
      where,
      connections: { min: 1, max: 8 },
      duration: { min: DMIN, max: DMAX },
      fetch: shim,
    });
    const events = record(st);
    // libcurl.js 0.7.4 is a web-only emscripten build. In Node it needs `window`, a `document`
    // to dispatch its load event on, and no `process` while the module evaluates (else it detects
    // Node and throws). `process` comes back at the `servers` event (the import is long done).
    const processDesc = Object.getOwnPropertyDescriptor(globalThis, "process");
    globalThis.window = globalThis;
    globalThis.document = new EventTarget();
    const restore = () => {
      if (!Object.getOwnPropertyDescriptor(globalThis, "process")) Object.defineProperty(globalThis, "process", processDesc);
    };
    st.on("servers", restore);
    st.on("error", restore);
    delete globalThis.process;
    let result;
    try {
      result = await st.start();
    } finally {
      restore();
    }
    const errors = events.filter((e) => e.name === "error");
    assert.deepEqual(errors, []);
    const servers = events.find((e) => e.name === "servers").d;
    t.diagnostic(`netflix targets: ${JSON.stringify(servers.targets)}`);
    const { download, latency, upload } = result;
    t.diagnostic(
      `netflix: download ${mbps(download.speedBps)} Mb/s (loaded ${download.loadedLatencyMs?.toFixed(1)} ms), ` +
      `unloaded ${latency.unloadedMs.toFixed(1)} ms, upload ${mbps(upload.speedBps)} Mb/s`,
    );
  });
});
