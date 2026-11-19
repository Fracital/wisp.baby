// Unit tests for the Wisp v1 packets, the HTTP/1.1 response parser, and the Wisp/HTTP clients
// against an in-memory fake Wisp server (checks the CONTINUE window is honoured), over a fake
// WebSocket and a fake WebTransport (length-prefixed packets on one stream, split at random).
// Run: node --test 'test/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import {
  PACKET,
  encodeConnect,
  encodeData,
  encodeContinue,
  encodeClose,
  decodePacket,
  HttpResponseParser,
  WispConnection,
  WtConnection,
  WispPool,
  webtransportConfig,
  webtransportConfigUrl,
  createSpeedtest,
  HttpConnection,
  makeTarget,
  netflixTargets,
  libcurlTransport,
  MAX_DATA_PAYLOAD,
} from "../site/speedtest.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- packets

test("Wisp CONNECT encodes type, LE stream id, stream type, LE port, hostname", () => {
  const p = encodeConnect(0x01020304, "1.2.3.4", 8080);
  assert.deepEqual([...p.subarray(0, 8)], [0x01, 0x04, 0x03, 0x02, 0x01, 0x01, 0x90, 0x1f]);
  assert.equal(dec.decode(p.subarray(8)), "1.2.3.4");
  const d = decodePacket(p.buffer);
  assert.equal(d.type, PACKET.CONNECT);
  assert.equal(d.streamId, 0x01020304);
  assert.equal(d.port, 8080);
  assert.equal(d.hostname, "1.2.3.4");
});

test("Wisp DATA / CONTINUE / CLOSE round trip", () => {
  const data = decodePacket(encodeData(7, enc.encode("hello")));
  assert.equal(data.type, PACKET.DATA);
  assert.equal(data.streamId, 7);
  assert.equal(dec.decode(data.payload), "hello");
  const cont = decodePacket(encodeContinue(0, 128));
  assert.equal(cont.type, PACKET.CONTINUE);
  assert.equal(cont.streamId, 0);
  assert.equal(cont.remaining, 128);
  const close = decodePacket(encodeClose(9));
  assert.equal(close.type, PACKET.CLOSE);
  assert.equal(close.reason, 0x02);
  assert.throws(() => encodeData(1, new Uint8Array(MAX_DATA_PAYLOAD + 1)));
  assert.throws(() => decodePacket(new Uint8Array(3)));
  // A view into a bigger buffer decodes at its own offset.
  const big = new Uint8Array(20);
  big.set(encodeContinue(5, 3), 4);
  assert.equal(decodePacket(big.subarray(4, 13)).remaining, 3);
});

// ---------------------------------------------------------------- HTTP parser

function collect(parser) {
  const out = { heads: [], body: 0, done: [] };
  parser.onhead = (h) => out.heads.push(h);
  parser.onbody = (n) => (out.body += n);
  parser.oncomplete = (h) => out.done.push({ status: h.status, keepAlive: h.keepAlive, body: out.body });
  return out;
}

const RESP = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nCache-Control: no-store\r\nX-A: 1\r\nx-a: 2\r\n\r\n0123456789";

test("HTTP: Content-Length body, split at every byte boundary", () => {
  const bytes = enc.encode(RESP);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const p = new HttpResponseParser();
    const out = collect(p);
    p.push(bytes.subarray(0, cut));
    p.push(bytes.subarray(cut));
    assert.equal(out.done.length, 1, `cut ${cut}`);
    assert.equal(out.body, 10);
    assert.equal(out.heads[0].headers["x-a"], "1, 2");
    assert.equal(out.heads[0].headers["cache-control"], "no-store");
    assert.equal(out.done[0].keepAlive, true);
    assert.ok(p.idle());
  }
});

test("HTTP: one byte at a time", () => {
  const bytes = enc.encode(RESP + RESP);
  const p = new HttpResponseParser();
  const out = collect(p);
  for (let i = 0; i < bytes.length; i++) p.push(bytes.subarray(i, i + 1));
  assert.equal(out.done.length, 2);
  assert.equal(out.body, 20);
});

test("HTTP: keep-alive, several responses in one chunk, interim 100 skipped", () => {
  const p = new HttpResponseParser();
  const out = collect(p);
  p.push(enc.encode(
    "HTTP/1.1 100 Continue\r\n\r\n" +
    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc" +
    "HTTP/1.1 204 No Content\r\n\r\n" +
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n" +
    "HTTP/1.1 403 Forbidden\r\ncontent-length: 2\r\nConnection: close\r\n\r\nno",
  ));
  assert.deepEqual(out.done.map((d) => d.status), [200, 204, 200, 403]);
  assert.equal(out.body, 5);
  assert.equal(out.done[3].keepAlive, false);
});

test("HTTP: chunked body with extensions and trailers", () => {
  const p = new HttpResponseParser();
  const out = collect(p);
  const text = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\nA\r\n0123456789\r\n0\r\nX-Trailer: y\r\n\r\n";
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += 3) p.push(bytes.subarray(i, i + 3));
  assert.equal(out.done.length, 1);
  assert.equal(out.body, 15);
  assert.ok(p.idle());
  assert.throws(() => new HttpResponseParser().push(enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")));
});

test("HTTP: close-delimited body completes on finish(); HTTP/1.0 is not keep-alive", () => {
  const p = new HttpResponseParser();
  const out = collect(p);
  p.push(enc.encode("HTTP/1.0 200 OK\r\n\r\nabcdef"));
  assert.equal(out.done.length, 0);
  assert.equal(p.finish(), true);
  assert.equal(out.done.length, 1);
  assert.equal(out.done[0].keepAlive, false);
  assert.equal(out.body, 6);
  // HTTP/1.0 with keep-alive and a length.
  const q = new HttpResponseParser();
  const o2 = collect(q);
  q.push(enc.encode("HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 1\r\n\r\nx"));
  assert.equal(o2.done[0].keepAlive, true);
});

test("HTTP: cut short or garbage", () => {
  const p = new HttpResponseParser();
  p.push(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"));
  assert.throws(() => p.finish());
  assert.equal(new HttpResponseParser().finish(), false);  // idle close is fine
  assert.throws(() => new HttpResponseParser().push(enc.encode("SSH-2.0-OpenSSH\r\n\r\n")));
  assert.throws(() => new HttpResponseParser().push(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n")));
});

// ---------------------------------------------------------------- targets

test("makeTarget / netflixTargets", () => {
  const t = makeTarget("http://203.0.113.7/speedtest/range/?c=us&n=1&t=abc");
  assert.equal(t.connectHost, "203.0.113.7");
  assert.equal(t.port, 80);
  assert.equal(t.hostHeader, "203.0.113.7");
  assert.equal(t.oca, "203.0.113.7");
  assert.equal(t.path("0-0"), "/speedtest/range/0-0?c=us&n=1&t=abc");
  const g = makeTarget("http://[2001:db8::1]:8080/speedtest/range/", { hostHeader: "wisp.baby", label: "x" });
  assert.equal(g.connectHost, "2001:db8::1");
  assert.equal(g.port, 8080);
  assert.equal(g.hostHeader, "wisp.baby");
  assert.equal(g.path("0-26214400"), "/speedtest/range/0-26214400");
  assert.throws(() => makeTarget("https://example.com/speedtest/range/"));
  const n = netflixTargets({
    client: { ip: "198.51.100.1" },
    targets: [
      { name: "a", url: "http://203.0.113.7/speedtest?c=us&t=x", location: { city: "Open Connect", country: "Netflix" } },
      { name: "b", url: "https://oca.example/speedtest?t=y", location: {} },
      { name: "c", url: "http://203.0.113.8/speedtest?t=z" },
    ],
  });
  assert.equal(n.length, 2);
  assert.equal(n[0].label, "Open Connect, Netflix");
  assert.equal(n[0].path("0-5"), "/speedtest/range/0-5?c=us&t=x");
  assert.equal(n[1].label, "c");
});

// ---------------------------------------------------------------- clients against a fake Wisp server

/**
 * In-memory WebSocket + Wisp v1 server + HTTP origin. GET /r/0-N answers N+1 bytes (in 1000-byte
 * DATA packets); POST reads Content-Length bytes and answers 200. The server gives a CONTINUE of
 * WINDOW after every WINDOW DATA packets it got, and records any packet sent beyond the window.
 */
function fakeWispFactory({ window = 4, closeEvery = 0 } = {}) {
  const stats = { violations: 0, dataPackets: 0, uploaded: 0, connects: 0, requests: 0, targets: [] };
  class FakeWS {
    constructor(url, proto) {
      assert.equal(proto, undefined, "no subprotocol (Wisp v1)");
      this.url = url;
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.streams = new Map();
      this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => this._out(encodeContinue(0, window)), 1);
    }
    _out(pkt) {
      setTimeout(() => {
        if (this.closed) return;
        assert.equal(this.binaryType, "arraybuffer");
        this.onmessage && this.onmessage({ data: pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength) });
      }, 0);
    }
    send(bytes) {
      const p = decodePacket(new Uint8Array(bytes).slice());
      if (p.type === PACKET.CONNECT) {
        stats.connects++;
        stats.targets.push(`${p.hostname}:${p.port}`);
        this.streams.set(p.streamId, { window, got: 0, buf: "", need: -1, served: 0 });
      } else if (p.type === PACKET.DATA) {
        const s = this.streams.get(p.streamId);
        if (!s) return;
        stats.dataPackets++;
        if (s.window <= 0) stats.violations++;
        s.window--;
        s.got++;
        if (s.got % window === 0) {
          s.window = window;
          this._out(encodeContinue(p.streamId, window));
        }
        this._http(p.streamId, s, p.payload);
      } else if (p.type === PACKET.CLOSE) {
        this.streams.delete(p.streamId);
      }
    }
    _http(id, s, payload) {
      if (s.need > 0) {
        s.need -= payload.length;
        stats.uploaded += payload.length;
        if (s.need === 0) this._respond(id, s, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", 0);
        return;
      }
      s.buf += dec.decode(payload);
      const end = s.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = s.buf.slice(0, end);
      s.buf = "";
      stats.requests++;
      const [method, path] = head.split(" ");
      assert.match(head, /\r\nHost: wisp\.baby\r\n/);
      if (method === "GET") {
        const n = Number(/\/r\/0-(\d+)/.exec(path)[1]) + 1;
        this._respond(id, s, `HTTP/1.1 200 OK\r\nContent-Length: ${n}\r\n\r\n`, n);
      } else {
        const cl = Number(/Content-Length: (\d+)/.exec(head)[1]);
        if (cl === 0) this._respond(id, s, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", 0);
        else s.need = cl;
      }
    }
    _respond(id, s, head, n) {
      s.served++;
      const close = closeEvery && s.served % closeEvery === 0;
      if (close) head = head.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n");
      this._out(encodeData(id, enc.encode(head)));
      for (let off = 0; off < n; off += 1000) this._out(encodeData(id, new Uint8Array(Math.min(1000, n - off))));
      if (close) this._out(encodeClose(id, 0x02));
    }
    close() {
      this.closed = true;
      setTimeout(() => this.onclose && this.onclose({ code: 1000 }), 0);
    }
  }
  return { FakeWS, stats };
}

const target = { connectHost: "198.51.100.9", port: 80, hostHeader: "wisp.baby" };

test("Wisp + HTTP: GET keep-alive, progress counts, latency timing", async () => {
  const { FakeWS, stats } = fakeWispFactory({ window: 4 });
  const conn = new WispConnection("ws://fake/", { WebSocket: FakeWS });
  await conn.open();
  assert.equal(conn.initialWindow, 4);
  const http = new HttpConnection(async () => conn, target);
  let progress = 0;
  const r1 = await http.request({ method: "GET", path: "/r/0-9999", onProgress: (n) => (progress += n) });
  assert.equal(r1.ok, true);
  assert.equal(r1.bytes, 10000);
  assert.equal(progress, 10000);
  assert.ok(r1.firstByte >= r1.start && r1.end >= r1.firstByte);
  const r2 = await http.request({ method: "GET", path: "/r/0-0" });
  assert.equal(r2.bytes, 1);
  assert.equal(stats.connects, 1, "keep-alive reuses the stream");
  conn.close();
});

test("Wisp + HTTP: POST body respects the CONTINUE window and reports all bytes", async () => {
  const { FakeWS, stats } = fakeWispFactory({ window: 3 });
  const conn = new WispConnection("ws://fake/", { WebSocket: FakeWS });
  await conn.open();
  const http = new HttpConnection(async () => conn, target);
  let progress = 0;
  const size = 1_000_000;  // 8 upload chunks, more than the window
  const r = await http.request({ method: "POST", path: "/r/0-999999", bodySize: size, onProgress: (n) => (progress += n) });
  assert.equal(r.ok, true);
  assert.equal(stats.uploaded, size);
  assert.equal(progress, size);
  assert.equal(stats.violations, 0, "never sent past the window");
  // A body-less POST (the pinger) on the same stream.
  const p = await http.request({ method: "POST", path: "/r/0-0", bodySize: 0 });
  assert.equal(p.ok, true);
  assert.equal(stats.connects, 1);
  conn.close();
});

test("Wisp + HTTP: Connection: close reconnects on a new stream", async () => {
  const { FakeWS, stats } = fakeWispFactory({ window: 8, closeEvery: 1 });
  const conn = new WispConnection("ws://fake/", { WebSocket: FakeWS });
  await conn.open();
  const http = new HttpConnection(async () => conn, target);
  for (let i = 0; i < 3; i++) {
    const r = await http.request({ method: "GET", path: "/r/0-2499" });
    assert.equal(r.bytes, 2500);
  }
  assert.equal(stats.connects, 3);
  conn.close();
});

test("Wisp: socket close fails the pending request", async () => {
  const { FakeWS } = fakeWispFactory({ window: 8 });
  const conn = new WispConnection("ws://fake/", { WebSocket: FakeWS });
  await conn.open();
  const http = new HttpConnection(async () => conn, target);
  // Closed once the body has started (not on a timer: the fake can serve all 2 MB within one).
  let closing = false;
  const onProgress = () => {
    if (!closing) {
      closing = true;
      conn.ws.close();
    }
  };
  const pending = http.request({ method: "GET", path: "/r/0-1999999", onProgress });
  await assert.rejects(pending, /closed/);
});

test("WispPool: warm opens up front, leases are exclusive and reused, closed ones replaced", async () => {
  const { FakeWS } = fakeWispFactory({ window: 8 });
  let made = 0;
  class Counting extends FakeWS {
    constructor(...a) {
      super(...a);
      made++;
    }
  }
  const pool = new WispPool("ws://fake/", { WebSocket: Counting });
  pool.warm(3);
  assert.equal(made, 3, "warm opens every socket at once");
  const [a, b, c] = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(new Set([a, b, c]).size, 3, "no two leases share a socket");
  assert.equal(made, 3);
  pool.release(a);
  assert.equal(await pool.acquire(), a, "a released socket is leased again");
  b.ws.close();  // the server dropped it
  await new Promise((r) => setTimeout(r, 5));
  pool.release(b);
  pool.warm(3);
  assert.equal(made, 4, "a closed socket is replaced");
  const d = await pool.acquire();
  assert.ok(d !== b && d.ready && !d.closed);
  pool.close();
  assert.ok([a, c, d].every((x) => x.closed), "close() closes leased sockets too");
  await assert.rejects(pool.acquire(), /stopped/);
});

// ---------------------------------------------------------------- WebTransport

/**
 * A fake WebTransport on the fake Wisp server above: the session's one bidirectional stream carries
 * Wisp packets each behind a u32 LE length. Toward the client the framed bytes are re-cut at
 * random (seeded) into reads of 1 byte to 3 KiB, so packets straddle reads and reads hold several
 * packets. A write resolves `writeDelay` ms after the fake took it (bytes in the browser's network
 * stack); `stats.resolvedData` is the DATA payload of resolved writes. `mode`: "ok", "refuse" (ready
 * and closed reject) or "hang" (ready never settles); `modes` sets it per session, in order.
 */
function fakeWtFactory({ window = 4, writeDelay = 0, mode = "ok", modes = null, closeEvery = 0 } = {}) {
  const { FakeWS, stats } = fakeWispFactory({ window, closeEvery });
  stats.sessions = [];
  stats.resolvedData = 0;
  stats.maxQueued = 0;
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (seed % n);
  };
  class FakeWT {
    constructor(url, options = {}) {
      stats.sessions.push({ url, options });
      assert.equal(options.protocols, undefined, "no protocols (Wisp v1)");
      // `modes`: one per session, in the order they are made (`mode` for any after them).
      const m = (modes && modes[stats.sessions.length - 1]) || mode;
      this.url = url;
      this.closed = new Promise((res, rej) => {
        this._closedOk = res;
        this._closedErr = rej;
      });
      this.closed.catch(() => {});
      if (m === "refuse") {
        this.ready = Promise.reject(new Error("refused"));
        this.ready.catch(() => {});
        setTimeout(() => this._closedErr(new Error("refused")), 0);
      } else if (m === "hang") {
        this.ready = new Promise(() => {});
      } else {
        this.ready = Promise.resolve();
      }
    }
    async createBidirectionalStream() {
      await this.ready;
      const srv = new FakeWS(this.url);
      srv.binaryType = "arraybuffer";
      this.srv = srv;
      let ctl;
      let out = [];
      let flushing = false;
      const readable = new ReadableStream({ start: (c) => (ctl = c) });
      const flush = () => {
        flushing = false;
        let all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
        let off = 0;
        for (const b of out) {
          all.set(b, off);
          off += b.length;
        }
        out = [];
        while (all.length) {
          const n = Math.min(all.length, rnd(3072));
          ctl.enqueue(all.slice(0, n));
          all = all.subarray(n);
        }
      };
      srv.onmessage = ({ data }) => {
        const p = new Uint8Array(data);
        const f = new Uint8Array(4 + p.length);
        new DataView(f.buffer).setUint32(0, p.length, true);
        f.set(p, 4);
        out.push(f);
        if (!flushing) {
          flushing = true;
          setTimeout(flush, 0);
        }
      };
      // The path dies: the stream errors at once (what was not read yet is lost), the session with it.
      this.drop = () => {
        srv.closed = true;
        ctl.error(new Error("connection lost"));
        this._closedErr(new Error("connection lost"));
      };
      srv.onclose = () => {
        try {
          ctl.close();
        } catch {
          /* closed */
        }
        this._closedOk({ closeCode: 0, reason: "" });
      };
      let pend = new Uint8Array(0);
      let queued = 0;
      const writable = new WritableStream({
        write: (chunk) => {
          assert.ok(chunk instanceof Uint8Array);
          const m = new Uint8Array(pend.length + chunk.length);
          m.set(pend);
          m.set(chunk, pend.length);
          pend = m;
          let data = 0;
          while (pend.length >= 4) {
            const n = new DataView(pend.buffer, pend.byteOffset).getUint32(0, true);
            if (pend.length < 4 + n) break;
            const pkt = pend.slice(4, 4 + n);
            pend = pend.subarray(4 + n);
            if (pkt[0] === PACKET.DATA) data += n - 5;
            srv.send(pkt);
          }
          queued += data;
          stats.maxQueued = Math.max(stats.maxQueued, queued);
          return new Promise((r) => setTimeout(r, writeDelay)).then(() => {
            queued -= data;
            stats.resolvedData += data;
          });
        },
      });
      return { readable, writable };
    }
    close() {
      if (this.srv) this.srv.close();
      else this._closedOk({ closeCode: 0, reason: "" });
    }
  }
  return { FakeWT, FakeWS, stats };
}

const HASH = { algorithm: "sha-256", value: Buffer.alloc(32, 7).toString("base64") };

test("WebTransport: framing across reads, GET keep-alive, hashes as serverCertificateHashes", async () => {
  const { FakeWT, stats } = fakeWtFactory({ window: 4 });
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT, hashes: [HASH] });
  await conn.open();
  assert.equal(conn.initialWindow, 4);
  assert.equal(conn.transport, "webtransport");
  const sch = stats.sessions[0].options.serverCertificateHashes;
  assert.equal(sch.length, 1);
  assert.equal(sch[0].algorithm, "sha-256");
  assert.deepEqual([...sch[0].value], [...Buffer.alloc(32, 7)]);
  const http = new HttpConnection(async () => conn, target);
  let progress = 0;
  for (const n of [10000, 1, 123457]) {
    const r = await http.request({ method: "GET", path: `/r/0-${n - 1}`, onProgress: (d) => (progress += d) });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, n);
  }
  assert.equal(progress, 10000 + 1 + 123457);
  assert.equal(stats.connects, 1, "keep-alive reuses the stream");
  conn.close();
  // No hashes: the browser checks the certificate itself.
  const { FakeWT: W2, stats: s2 } = fakeWtFactory();
  const c2 = new WtConnection("https://fake/", { WebTransport: W2 });
  await c2.open();
  assert.equal(s2.sessions[0].options.serverCertificateHashes, undefined);
  c2.close();
});

test("WebTransport: POST respects the CONTINUE window and counts only bytes whose writes resolved", async () => {
  const { FakeWT, stats } = fakeWtFactory({ window: 3, writeDelay: 3 });
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn.open();
  const http = new HttpConnection(async () => conn, target);
  let progress = 0;
  let ahead = 0;
  let lagged = false;
  const size = 1_000_000;
  const r = await http.request({
    method: "POST",
    path: "/r/0-999999",
    bodySize: size,
    onProgress: (n) => {
      progress += n;
      // Before the 200 (which reports the rest, like XHR's onload) nothing is counted that the
      // fake has not taken in a resolved write.
      if (progress < size && progress > stats.resolvedData) ahead++;
      if (conn.bufferedAmount > 0) lagged = true;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(stats.uploaded, size);
  assert.equal(progress, size);
  assert.equal(ahead, 0, "progress never ran ahead of resolved writes");
  assert.ok(lagged, "the count waited for writes to resolve");
  assert.equal(stats.violations, 0, "never sent past the window");
  const p = await http.request({ method: "POST", path: "/r/0-0", bodySize: 0 });
  assert.equal(p.ok, true);
  await new Promise((res) => setTimeout(res, 10));  // the fake answers before its writes resolve
  assert.equal(conn.bufferedAmount, 0);
  conn.close();
});

test("WebTransport: Connection: close reconnects on a new stream; a lost session fails the request", async () => {
  const { FakeWT, stats } = fakeWtFactory({ window: 8, closeEvery: 1 });
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn.open();
  const http = new HttpConnection(async () => conn, target);
  for (let i = 0; i < 3; i++) assert.equal((await http.request({ method: "GET", path: "/r/0-2499" })).bytes, 2500);
  assert.equal(stats.connects, 3);
  let closing = false;
  const onProgress = () => {
    if (!closing) {
      closing = true;
      conn.wt.drop();
    }
  };
  let closed = false;
  conn.onclose = () => (closed = true);
  await assert.rejects(http.request({ method: "GET", path: "/r/0-1999999", onProgress }), /closed/);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(conn.closed && closed);
});

test("WebTransport: open fails on a refused session, a timeout, a missing constructor", async () => {
  const { FakeWT } = fakeWtFactory({ mode: "refuse" });
  await assert.rejects(new WtConnection("https://fake/", { WebTransport: FakeWT }).open(), /refused/);
  const { FakeWT: Hang } = fakeWtFactory({ mode: "hang" });
  const h = new WtConnection("https://fake/", { WebTransport: Hang });
  await assert.rejects(h.open(30), /timed out/);
  assert.ok(h.closed);
  await assert.rejects(new WtConnection("https://fake/", { WebTransport: undefined }).open(), /no WebTransport/);
  // close() while opening rejects the open at once.
  const { FakeWT: Hang2 } = fakeWtFactory({ mode: "hang" });
  const c = new WtConnection("https://fake/", { WebTransport: Hang2 });
  const opening = c.open(10000);
  c.close();
  await assert.rejects(opening, /closed/);
});

test("WebTransport: a length prefix past any Wisp packet breaks the session", async () => {
  const { FakeWT } = fakeWtFactory();
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn.open();
  conn._feed(new Uint8Array([0xff, 0xff, 0xff, 0x7f, 1, 2]));
  assert.ok(conn.closed);
});

test("webtransportConfig / webtransportConfigUrl", () => {
  assert.equal(webtransportConfigUrl("wss://wisp.baby/"), "https://wisp.baby/webtransport.json");
  assert.equal(webtransportConfigUrl("ws://127.0.0.1:6011/x/"), "http://127.0.0.1:6011/webtransport.json");
  assert.equal(webtransportConfigUrl("https://wisp.baby/"), null);
  assert.equal(webtransportConfigUrl("nope"), null);
  assert.deepEqual(webtransportConfig({ url: "https://holywisp.fracit.al/", hashes: [] }, "wss://wisp.baby/"), {
    url: "https://holywisp.fracit.al/",
    hashes: [],
  });
  // "" is holyWisp's default: the relay's own host and port.
  assert.deepEqual(webtransportConfig({ url: "", hashes: [HASH, { algorithm: "md5", value: "x" }, null] }, "ws://127.0.0.1:6011/"), {
    url: "https://127.0.0.1:6011/",
    hashes: [HASH],
  });
  assert.equal(webtransportConfig({ url: "http://x/", hashes: [] }, "wss://wisp.baby/"), null);
  assert.equal(webtransportConfig({ url: "https://x/" }, "wss://wisp.baby/"), null);
  assert.equal(webtransportConfig(null, "wss://wisp.baby/"), null);
  assert.equal(webtransportConfig("<html>", "wss://wisp.baby/"), null);
});

// The engine's choice of transport: watch the `transport` event, then stop (the fake server does
// not serve the speed test's paths).
function chooseWith({ transport, wt, WebTransport, webtransport = { url: "https://fake-wt/", hashes: [] } }) {
  const { FakeWS } = fakeWispFactory({ window: 8 });
  let wsMade = 0;
  class CountingWS extends FakeWS {
    constructor(...a) {
      super(...a);
      wsMade++;
    }
  }
  const st = createSpeedtest({
    mode: "gcore",
    wispUrl: "ws://fake/",
    where: { addr: "198.51.100.9", host: "test" },
    connections: { min: 1, max: 3 },
    transport,
    webtransport,
    WebSocket: CountingWS,
    WebTransport: WebTransport !== undefined ? WebTransport : wt && wt.FakeWT,
  });
  const events = [];
  for (const name of ["phase", "transport", "error"]) st.on(name, (d) => events.push({ name, d }));
  return new Promise((resolve) => {
    st.on("transport", (d) => {
      st.stop();
      resolve({ via: d, events, wsMade: () => wsMade });
    });
    st.on("error", (d) => resolve({ error: d, events, wsMade: () => wsMade }));
    st.start();
  });
}

test("engine: auto uses WebTransport when the listener answers", async () => {
  const wt = fakeWtFactory();
  const r = await chooseWith({ transport: undefined, wt, webtransport: { url: "https://fake-wt/", hashes: [HASH] } });
  assert.deepEqual(r.via, { transport: "webtransport", url: "https://fake-wt/", fallback: null });
  assert.equal(wt.stats.sessions.length, 1, "one session opened before the transport is reported");
  assert.equal(wt.stats.sessions[0].options.serverCertificateHashes.length, 1);
  assert.equal(r.wsMade(), 0);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.events.filter((e) => e.name !== "transport" && e.name !== "phase").length, 0);
  assert.deepEqual(r.events.filter((e) => e.name === "phase").map((e) => e.d.phase), ["servers"], "nothing after stop()");
});

test("engine: auto falls back to WebSocket when WebTransport fails twice, is missing or not offered", async () => {
  const wtRefused = fakeWtFactory({ mode: "refuse" });
  const t0 = Date.now();
  const refused = await chooseWith({ transport: "auto", wt: wtRefused });
  assert.equal(refused.via.transport, "websocket");
  assert.equal(refused.via.url, "ws://fake/");
  assert.equal(refused.via.fallback, "refused (2 tries)");
  assert.equal(wtRefused.stats.sessions.length, 2, "a second, fresh session before giving up");
  assert.ok(Date.now() - t0 >= 450, "the retry waits a moment after a refusal");
  // Two different reasons are both reported.
  const { FakeWT: Refuse } = fakeWtFactory({ mode: "refuse" });
  let made = 0;
  class Mixed extends Refuse {
    constructor(...a) {
      super(...a);
      if (++made === 2) {
        this.ready = Promise.reject(new Error("no route"));
        this.ready.catch(() => {});
      }
    }
  }
  const mixed = await chooseWith({ transport: "auto", WebTransport: Mixed });
  assert.equal(mixed.via.fallback, "refused; then no route");
  const missing = await chooseWith({ transport: "auto", WebTransport: null });
  assert.deepEqual(missing.via, { transport: "websocket", url: "ws://fake/", fallback: null });
  const wt = fakeWtFactory();
  const none = await chooseWith({ transport: "auto", wt, webtransport: { not: "a description" } });
  assert.deepEqual(none.via, { transport: "websocket", url: "ws://fake/", fallback: null });
  assert.equal(wt.stats.sessions.length, 0);
});

test("engine: auto retries a session that failed, and opens no WebSocket when the retry works", async () => {
  const wt = fakeWtFactory({ modes: ["refuse", "ok"] });
  const r = await chooseWith({ transport: "auto", wt });
  assert.deepEqual(r.via, { transport: "webtransport", url: "https://fake-wt/", fallback: null });
  assert.equal(wt.stats.sessions.length, 2);
  assert.equal(r.wsMade(), 0);
});

test("engine: stop() while auto waits to retry opens nothing more", async () => {
  const wt = fakeWtFactory({ mode: "refuse" });
  const { FakeWS } = fakeWispFactory();
  let wsMade = 0;
  const st = createSpeedtest({
    mode: "gcore",
    wispUrl: "ws://fake/",
    where: { addr: "198.51.100.9" },
    webtransport: { url: "https://fake-wt/", hashes: [] },
    WebTransport: wt.FakeWT,
    WebSocket: class extends FakeWS {
      constructor(...a) {
        super(...a);
        wsMade++;
      }
    },
  });
  const events = [];
  for (const name of ["transport", "error", "servers"]) st.on(name, (d) => events.push(name));
  const done = st.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(wt.stats.sessions.length, 1);
  st.stop();
  assert.equal(await done, null);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(wt.stats.sessions.length, 1, "no second session after stop()");
  assert.equal(wsMade, 0);
  assert.deepEqual(events, []);
});

test("engine: transport websocket never opens WebTransport; webtransport never falls back", async () => {
  const wt = fakeWtFactory();
  const ws = await chooseWith({ transport: "websocket", wt });
  assert.equal(ws.via.transport, "websocket");
  assert.equal(wt.stats.sessions.length, 0);
  const wtForced = fakeWtFactory({ mode: "refuse" });
  const forced = await chooseWith({ transport: "webtransport", wt: wtForced });
  assert.equal(forced.error.phase, "servers");
  assert.match(forced.error.message, /WebTransport to https:\/\/fake-wt\/: .*refused/);
  assert.equal(forced.wsMade(), 0);
  assert.equal(wtForced.stats.sessions.length, 1, "forced: one try of its own, no retry");
  const forcedNone = await chooseWith({ transport: "webtransport", WebTransport: null });
  assert.match(forcedNone.error.message, /no WebTransport/);
  assert.throws(() => createSpeedtest({ mode: "gcore", wispUrl: "ws://x/", transport: "quic" }), /unknown transport/);
});

test("WispPool over WebTransport: adopt, warm, exclusive leases", async () => {
  const { FakeWT, stats } = fakeWtFactory();
  const connect = () => new WtConnection("https://fake/", { WebTransport: FakeWT });
  const first = connect();
  await first.open();
  const pool = new WispPool("https://fake/", { connect });
  pool.adopt(first);
  pool.warm(3);
  assert.equal(stats.sessions.length, 3, "warm opens the rest");
  const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(new Set(leases).size, 3);
  assert.ok(leases.includes(first));
  assert.ok(leases.every((c) => c instanceof WtConnection && c.ready));
  pool.close();
  assert.ok(leases.every((c) => c.closed));
});

test("WispPool.shared: an open connection without a lease, opening one only when there is none", async () => {
  const { FakeWT, stats } = fakeWtFactory();
  const connect = () => new WtConnection("https://fake/", { WebTransport: FakeWT });
  const pool = new WispPool("https://fake/", { connect });
  const a = await pool.shared();
  assert.equal(stats.sessions.length, 1, "none at all: one is opened");
  assert.ok(a.ready);
  assert.equal(await pool.shared(), a, "idle and open: that one");
  const leased = await pool.acquire();
  assert.equal(leased, a);
  assert.equal(await pool.shared(), a, "leased by a worker: shared anyway, nothing new opened");
  assert.equal(stats.sessions.length, 1);
  pool.close();
  await assert.rejects(pool.shared(), /stopped/);
});

/**
 * What libcurl.js 0.7.4's SOCKFS does with a custom transport for one TCP connection: construct it
 * with `<set_websocket url><host>:<port>`, set binaryType, assign the four handlers, compare
 * readyState with the instance's constants, send ArrayBuffers only while OPEN, close().
 */
function libcurlSocket(Transport, url) {
  const ws = new Transport(url);
  ws.binaryType = "arraybuffer";
  const sock = { ws, events: [], data: [], opened: null, closed: null };
  sock.opened = new Promise((ok) => (ws.onopen = () => (sock.events.push("open"), ok())));
  sock.closed = new Promise((ok) => (ws.onclose = (ev) => (sock.events.push(`close ${ev.code}`), ok())));
  ws.onerror = () => sock.events.push("error");
  ws.onmessage = (ev) => {
    assert.ok(ev.data instanceof ArrayBuffer);
    sock.data.push(new Uint8Array(ev.data));
  };
  sock.send = (str) => {
    if (ws.readyState === ws.CONNECTING) throw new Error("EAGAIN");
    assert.equal(ws.readyState, ws.OPEN);
    const u8 = typeof str === "string" ? enc.encode(str) : str;
    ws.send(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  };
  sock.text = () => dec.decode(Buffer.concat(sock.data));
  return sock;
}

test("libcurl transport: a TCP connection as one Wisp stream on the run's WebTransport session", async () => {
  const { FakeWT, stats } = fakeWtFactory({ window: 4 });
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn.open();
  let asked = 0;
  const T = libcurlTransport(() => (asked++, conn));
  assert.equal(T.OPEN, 1);
  const s = libcurlSocket(T, "ws://fake/198.51.100.9:80");
  assert.equal(s.ws.readyState, s.ws.CONNECTING);
  assert.throws(() => s.send("x"), /EAGAIN/);
  await s.opened;
  assert.equal(asked, 1);
  assert.deepEqual(stats.targets, ["198.51.100.9:80"]);
  assert.equal(stats.sessions.length, 1, "no session of its own");
  // A body bigger than one DATA packet, sent in one go: split, and only inside the window.
  const body = new Uint8Array(MAX_DATA_PAYLOAD * 2 + 1000);
  s.send(`POST /up HTTP/1.1\r\nHost: wisp.baby\r\nContent-Length: ${body.length}\r\n\r\n`);
  s.send(body);
  await waitUntil(() => s.text().includes("200 OK"));
  assert.equal(stats.uploaded, body.length);
  assert.equal(stats.violations, 0, "never past the CONTINUE window");
  s.data.length = 0;
  s.send("GET /r/0-99999 HTTP/1.1\r\nHost: wisp.baby\r\nAccept: */*\r\n\r\n");
  await waitUntil(() => s.data.reduce((n, d) => n + d.length, 0) >= 100000);
  assert.match(s.text(), /^HTTP\/1\.1 200 OK\r\nContent-Length: 100000\r\n/);
  s.ws.close();
  assert.equal(s.ws.readyState, s.ws.CLOSING);
  await s.closed;
  assert.equal(s.ws.readyState, s.ws.CLOSED);
  assert.deepEqual(s.events, ["open", "close 1000"]);
  assert.equal(conn.streams.size, 0, "the stream is closed with it");
  assert.ok(!conn.closed, "the session stays");
  conn.close();
});

test("libcurl transport: IPv6 targets, remote close, a lost session, no connection, bad URLs", async () => {
  const { FakeWT, stats } = fakeWtFactory({ window: 4, closeEvery: 1 });
  const conn = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn.open();
  const T = libcurlTransport(async () => conn);
  // The server ends the connection (CLOSE 0x02 after Connection: close): a clean close, no error.
  const a = libcurlSocket(T, "wss://wisp.baby/2001:db8::7:443");
  await a.opened;
  assert.deepEqual(stats.targets, ["2001:db8::7:443"]);
  a.send("GET /r/0-9 HTTP/1.1\r\nHost: wisp.baby\r\nAccept: */*\r\n\r\n");
  await a.closed;
  assert.match(a.text(), /Connection: close/);
  assert.deepEqual(a.events, ["open", "close 1000"]);
  // The session dies under an open stream: error, then close.
  const b = libcurlSocket(T, "wss://wisp.baby/[2001:db8::8]:80");
  await b.opened;
  assert.equal(stats.targets[1], "2001:db8::8:80");
  conn.close();
  await b.closed;
  assert.deepEqual(b.events, ["open", "error", "close 1006"]);
  // No connection to be had: error, then close, never open.
  const c = libcurlSocket(libcurlTransport(() => Promise.reject(new Error("stopped"))), "wss://wisp.baby/api.fast.com:443");
  await c.closed;
  assert.deepEqual(c.events, ["error", "close 1006"]);
  // Closed while still connecting: nothing is opened later.
  let late;
  const d = libcurlSocket(libcurlTransport(() => new Promise((r) => (late = r))), "wss://wisp.baby/api.fast.com:443");
  d.ws.close();
  await d.closed;
  const conn2 = new WtConnection("https://fake/", { WebTransport: FakeWT });
  await conn2.open();
  late(conn2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(conn2.streams.size, 0);
  assert.deepEqual(d.events, ["close 1000"]);
  conn2.close();
  assert.throws(() => new T("wss://wisp.baby/"), /host:port/);
  assert.throws(() => new T("wss://wisp.baby/x:0"), /host:port/);
});

async function waitUntil(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * A stand-in for libcurl.js in Netflix mode: set_websocket, `transport`, HTTPSession with fetch and
 * close. Its fetch makes one TCP connection to api.fast.com:443 the way libcurl does: through the
 * custom transport when `transport` is a class (and speaks plain HTTP to the fake server, which
 * answers anything), or through its own Wisp WebSocket to the set_websocket URL when it is "wisp".
 */
function fakeLibcurl(FakeWS) {
  const lc = { transport: "wisp", websocketUrl: null, calls: [], sockets: 0 };
  lc.set_websocket = (url) => (lc.websocketUrl = url);
  const answer = { targets: [{ name: "oca", url: "http://198.51.100.20/speedtest?c=us", location: { city: "Testville", country: "US" } }] };
  lc.HTTPSession = class {
    async fetch(url) {
      assert.equal(new URL(url).host, "api.fast.com");
      lc.calls.push(typeof lc.transport === "function" ? "custom" : lc.transport);
      if (typeof lc.transport === "function") {
        const s = libcurlSocket(lc.transport, `${lc.websocketUrl}api.fast.com:443`);
        await s.opened;
        lc.sockets++;
        s.send("GET /r/0-9 HTTP/1.1\r\nHost: wisp.baby\r\nAccept: */*\r\n\r\n");
        await waitUntil(() => s.text().endsWith("\r\n\r\n" + "\0".repeat(10)));
        s.ws.close();
        await s.closed;
      } else {
        new FakeWS(lc.websocketUrl).close();  // libcurl's own Wisp WebSocket
      }
      return { ok: true, status: 200, json: async () => answer };
    }
    close() {}
  };
  return lc;
}

function netflixWith({ transport = "auto", wt, FakeWS }) {
  let wsMade = 0;
  class CountingWS extends FakeWS {
    constructor(...a) {
      super(...a);
      wsMade++;
    }
  }
  const libcurl = fakeLibcurl(CountingWS);
  const st = createSpeedtest({
    mode: "netflix",
    wispUrl: "wss://wisp.baby/",
    where: { host: "test" },
    connections: { min: 1, max: 3 },
    transport,
    webtransport: { url: "https://fake-wt/", hashes: [] },
    WebSocket: CountingWS,
    WebTransport: wt && wt.FakeWT,
    libcurl,
  });
  const events = [];
  for (const name of ["servers", "transport", "error"]) st.on(name, (d) => events.push({ name, d }));
  return new Promise((resolve) => {
    st.on("transport", () => {
      st.stop();
      resolve({ events, libcurl, wsMade });
    });
    st.on("error", (d) => resolve({ error: d, events, libcurl, wsMade }));
    st.start();
  });
}

test("engine, Netflix mode over WebTransport: api.fast.com through the run's session, no WebSocket", async () => {
  const wt = fakeWtFactory({ window: 8 });
  const r = await netflixWith({ wt, FakeWS: wt.FakeWS });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.events.map((e) => e.name), ["servers", "transport"], "servers, then transport, as before");
  assert.equal(r.events[0].d.targets[0].label, "Testville, US");
  assert.equal(r.events[1].d.transport, "webtransport");
  assert.deepEqual(r.libcurl.calls, ["custom"]);
  assert.equal(r.libcurl.sockets, 1);
  assert.deepEqual(wt.stats.targets, ["api.fast.com:443"], "a Wisp stream to api.fast.com");
  assert.equal(wt.stats.sessions.length, 1, "on the session the transport was proven with");
  assert.equal(r.wsMade, 0, "no WebSocket at all");
});

test("engine, Netflix mode over WebSocket: libcurl opens its own Wisp WebSocket, as before", async () => {
  const wt = fakeWtFactory({ window: 8 });
  const r = await netflixWith({ transport: "websocket", wt, FakeWS: wt.FakeWS });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.libcurl.calls, ["wisp"]);
  assert.equal(r.libcurl.websocketUrl, "wss://wisp.baby/");
  assert.equal(wt.stats.sessions.length, 0);
  // And after a WebTransport run, the next WebSocket run puts libcurl back on its own transport.
  const r2 = await netflixWith({ wt: fakeWtFactory({ window: 8 }), FakeWS: wt.FakeWS });
  assert.deepEqual(r2.libcurl.calls, ["custom"]);
  const shared = fakeLibcurl(wt.FakeWS);
  shared.transport = libcurlTransport(() => null);
  const st = createSpeedtest({ mode: "netflix", wispUrl: "wss://wisp.baby/", transport: "websocket", WebSocket: wt.FakeWS, libcurl: shared });
  await new Promise((resolve) => {
    st.on("transport", () => (st.stop(), resolve()));
    st.on("error", resolve);
    st.start();
  });
  assert.deepEqual(shared.calls, ["wisp"]);
});
