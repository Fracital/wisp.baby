// Unit tests for the Wisp v1 packets, the HTTP/1.1 response parser, and the Wisp/HTTP clients
// against an in-memory fake Wisp server (checks the CONTINUE window is honoured).
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
  WispPool,
  HttpConnection,
  makeTarget,
  netflixTargets,
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
  const stats = { violations: 0, dataPackets: 0, uploaded: 0, connects: 0, requests: 0 };
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
  const pending = http.request({ method: "GET", path: "/r/0-1999999" });
  setTimeout(() => conn.ws.close(), 5);
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
