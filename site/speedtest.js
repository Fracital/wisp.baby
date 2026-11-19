// wisp.baby speed-test engine. ES module, no dependencies.
//
// Three layers, bottom up:
//   1. A small Wisp v1 client (one WebSocket or one WebTransport session, many TCP streams, the
//      CONTINUE send window).
//   2. A minimal HTTP/1.1 client on one Wisp stream (keep-alive, Content-Length, chunked,
//      close-delimited bodies; byte-level progress; time to first response byte).
//   3. fast.com's measuring algorithm, ported from its tester (README "The fast.com algorithm"):
//      workers, the ramp, 150 ms snapshots, stableMovingAverage(5), the stableDelta stopper,
//      loaded and unloaded latency, retries and bad-server bookkeeping.
//
// The contract (options, events, server endpoints) is README.md.
//
//   import { createSpeedtest } from "./speedtest.js";
//   const t = createSpeedtest({ mode, wispUrl, where, connections, duration, libcurlBase,
//                               transport, webtransport });
//   t.on("download", (e) => ...); t.start(); t.stop();

// ============================================================================ constants

const MAX_PAYLOAD_BYTES = 26214400;      // fast.com MAX_PAYLOAD_BYTES; requests are range/0-<this - n>
const PROGRESS_MS = 150;                 // fast.com progressFrequencyMs: one snapshot tick
const MAX_ATTEMPTS = 10;                 // fast.com maxAttempts
const LATENCY_FREQ_MS = 1000;            // fast.com latencyMeasurementsFrequencyMs (loaded pings)
const PROGRESS_EVENT_MS = 50;            // coalesce byte counts like XHR progress events (~50 ms)
const REQUEST_IDLE_TIMEOUT_MS = 9000;    // fast.com requester timeout (9 s without progress)
const REQUEST_TOTAL_TIMEOUT_MS = 60000;  // fast.com xhr.timeout
const FAILED_REQUEST_BACKOFF_MS = 200;   // ours: pause after a failed request, so a dead path can't spin
const UNLOADED_MIN_S = 5;                // the latency test runs > 5 s ...
const UNLOADED_MIN_SAMPLES = 50;         // ... with > 50 samples

// Wisp: client → server DATA payloads may be up to 262144 bytes (holyWisp max-message-size 262149
// = payload + 5-byte header). Upload chunks are much smaller on purpose: the CONTINUE window counts
// packets (holyWisp: 128, refilled about a quarter at a time), so the chunk size sets how many bytes
// may sit at the relay ahead of the remote. At 128 KiB that is 16 MiB per stream, and the upload
// then moves in multi-MB bursts several seconds apart whenever the relay → server leg is the slow
// one, which starves the snapshots (every worker must have new bytes). 32 KiB keeps it to 4 MiB
// with ~1 MiB refills. The cap on the connection's bufferedAmount (the WebSocket's, or the bytes
// whose WebTransport write has not resolved) keeps the browser from queueing the whole body.
export const MAX_DATA_PAYLOAD = 262144;
const UPLOAD_CHUNK = 32768;
const MAX_BUFFERED = 4 * 1024 * 1024;

// WebTransport: how long `auto` waits for the session and its stream-0 CONTINUE before it runs the
// test over WebSocket instead (a network that drops UDP never answers; on one that carries it the
// QUIC handshake is one round trip). An explicit `transport: "webtransport"` waits as long as a
// WebSocket handshake. A Wisp packet on the session's stream is at most this long (holyWisp sends
// at most 128 KiB of payload per packet); a longer length prefix is a broken stream.
export const TRANSPORTS = ["auto", "webtransport", "websocket"];
const WT_AUTO_TIMEOUT_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const WT_MAX_PACKET = 16 * 1024 * 1024;

const API_FAST_COM =
  "https://api.fast.com/netflix/speedtest/v2?https=false&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5";
const LIBCURL_BASE = "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.4/";
const LIBCURL_MJS_SHA384_B64 = "HPoVcSWmDnDfiUF+cQungoKNOHcIxImN/etFDay9rQosy344svK4dmplcAC8nIRP";
const LIBCURL_WASM_SHA256_HEX = "fe42bbcbd90b06c020ee4e0f11b86e8a671bfbb8fea3ee27200b116b7286dea9";

// ============================================================================ algorithm pieces
// Pure functions and small state machines, exported for the unit tests.

/** fast.com utils.percentile: sort, index = (n-1)·p, linear interpolation between floor and floor+1. */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (v.length === 0) return undefined;
  v.sort((a, b) => a - b);
  if (p <= 0) return v[0];
  if (p >= 1) return v[v.length - 1];
  const index = (v.length - 1) * p;
  const lower = Math.floor(index);
  const weight = index - lower;
  // fast.com reads v[lower + 1] even when it is past the end (one sample → NaN); we don't.
  return lower + 1 < v.length ? v[lower] * (1 - weight) + v[lower + 1] * weight : v[lower];
}

/**
 * fast.com aggregator/stableMovingAverage(windowSize, resetThreshold). Returns a stateful function
 * of the growing snapshot array ({bytes, time} with time in ms) that returns bits per second.
 *
 * While the start is not fixed, every call looks at the last `windowSize` snapshots: if that
 * window's rate is at least the best seen so far, the average restarts from that window (so a slow
 * TCP ramp-up is dropped); the first window slower than the best fixes the start. From then on
 * every new snapshot is added to the running sums. Fewer than `resetThreshold` snapshots (a new
 * attempt) resets everything.
 */
export function createStableMovingAverage(windowSize = 5, resetThreshold = 5) {
  let startInd, curSpeed, bytes, time, fixedStart;
  function reset() {
    startInd = 0;
    curSpeed = 0;
    bytes = 0;
    time = 0;
    fixedStart = false;
  }
  reset();
  return function movingAvg(snapshots) {
    if (snapshots.length < resetThreshold) reset();
    if (!fixedStart) {
      let sumBytes = 0;
      let sumTime = 0;
      const last = snapshots.length - 1;
      const first = Math.max(0, snapshots.length - windowSize);
      for (let i = last; i >= first; i--) {
        sumBytes += snapshots[i].bytes;
        sumTime += snapshots[i].time;
      }
      const speed = sumTime > 0 ? sumBytes / sumTime : 0;
      if (speed >= curSpeed) {
        startInd = last + 1;
        curSpeed = speed;
        bytes = sumBytes;
        time = sumTime;
      } else {
        fixedStart = true;
      }
    }
    for (let i = startInd; i < snapshots.length; i++) {
      bytes += snapshots[i].bytes;
      time += snapshots[i].time;
    }
    startInd = snapshots.length;
    return time > 0 ? (1000 * bytes * 8) / time : 0;
  };
}

/**
 * fast.com stopper/stableDeltaMeasurementsStopper. `progressMeasurements` are the speeds reported
 * on earlier ticks ({speed}); `speed` is this tick's (not yet in the list). Complete when
 * testTime ≥ maxDuration, or when: there are ≥ minStable measurements, the fastest of the last
 * ceil(minStable/2) is the oldest of them (the speed stopped rising), every one of the last
 * minStable is within stabilityDelta % of `speed`, and testTime ≥ minDuration.
 */
export function createStableDeltaStopper({
  minDuration = 7,
  maxDuration = 30,
  stabilityDelta = 2,
  minStableMeasurements = 6,
} = {}) {
  const half = Math.ceil(minStableMeasurements / 2);
  return function isCompleted({ testTime, progressMeasurements: m, speed }) {
    if (testTime >= maxDuration) return true;
    const n = m.length;
    if (n < minStableMeasurements) return false;
    // Index of the max over the last `half`, scanning newest → oldest; ties go to the older one.
    let maxInd = 0;
    let maxSpeed = 0;
    for (let i = n - 1; i >= Math.max(0, n - half); i--) {
      if (m[i].speed >= maxSpeed) {
        maxSpeed = m[i].speed;
        maxInd = i;
      }
    }
    if (n - maxInd < half) return false;
    for (let i = n - minStableMeasurements; i < n; i++) {
      // Written as "not >", like fast.com: 0/0 = NaN passes.
      if ((100 * Math.abs(m[i].speed - speed)) / speed > stabilityDelta) return false;
    }
    return testTime >= minDuration;
  };
}

/**
 * fast.com's ramp (tester reportMetrics): how many workers should be active after this tick.
 * `speedBps` is undefined on a tick without an active snapshot, which never ramps.
 * Clamped to `max` (fast.com can overshoot a max below 3).
 */
export function rampTarget(speedBps, active, max) {
  if (!(active < max)) return active;
  let desired = active;
  if (speedBps > 5e7) desired = max;
  else if (speedBps > 1e7 && active < 5) desired = 5;
  else if (speedBps > 1e6 && active < 3) desired = 3;
  if (speedBps > 5e5 && active < 2) desired = 3;
  return Math.min(desired, max);
}

/**
 * fast.com's snapshot module. Each worker has a list of progress measurements
 * ({bytes, start, end}, contiguous per worker). Every tick:
 *  - if any worker has nothing new since the last snapshot, there is no snapshot this tick (its
 *    time folds into the next one, because the next measurement starts where the last ended);
 *  - the snapshot ends at the earliest "latest end" over the workers; measurements past that end
 *    are carried to the next snapshot (one straddling it is split pro rata);
 *  - bytes = sum, time = length of the union of the measurement intervals (ms).
 */
export function createSnapshotter() {
  let snapshots, lastProcessed, overflow;
  function reset() {
    snapshots = [];
    lastProcessed = {};
    overflow = {};
  }
  reset();

  function compute(workerMeasurements) {
    const ids = Object.keys(workerMeasurements);
    if (ids.length === 0) return undefined;
    // Gather first and commit only once every worker has something (fast.com cleared earlier
    // workers' carried bytes before bailing out; we don't lose them).
    const gathered = [];
    let end;
    for (const id of ids) {
      const list = workerMeasurements[id];
      const from = lastProcessed[id] || 0;
      const carried = overflow[id] || [];
      if (!(from < list.length || carried.length > 0)) return undefined;
      const ms = carried.concat(list.slice(from));
      gathered.push({ id, ms, count: list.length });
      const lastEnd = ms[ms.length - 1].end;
      if (end === undefined || lastEnd < end) end = lastEnd;
    }
    const kept = [];
    for (const { id, ms, count } of gathered) {
      lastProcessed[id] = count;
      const carry = [];
      for (const m of ms) {
        if (m.start >= end) {
          carry.push(m);
        } else if (m.end > end) {
          const overBytes = (m.bytes * (m.end - end)) / (m.end - m.start);
          kept.push({ start: m.start, end, bytes: m.bytes - overBytes });
          carry.push({ start: end, end: m.end, bytes: overBytes });
        } else {
          kept.push(m);
        }
      }
      overflow[id] = carry;
    }
    if (kept.length === 0) return undefined;
    kept.sort((a, b) => a.start - b.start);
    const snap = { bytes: 0, time: 0, start: kept[0].start, end: kept[0].start };
    let cur = snap.start;
    for (const m of kept) {
      cur = Math.max(cur, m.start);
      if (m.end > cur) {
        snap.time += m.end - cur;
        cur = m.end;
      }
      snap.bytes += m.bytes;
    }
    snap.end = cur;
    snapshots.push(snap);
    return snap;
  }

  return { reset, compute, all: () => snapshots, length: () => snapshots.length };
}

/** fast.com computeLoadedLatency: min over workers with > 4 samples of their p75 (all workers if none). */
export function loadedLatency(latencyMeasurements) {
  const lists = Object.values(latencyMeasurements);
  let count = 0;
  for (const l of lists) count += l.length;
  let vals = lists.filter((l) => l.length > 4).map((l) => percentile(l, 0.75));
  if (vals.length === 0) vals = lists.map((l) => percentile(l, 0.75));
  vals = vals.filter((v) => Number.isFinite(v));
  return { value: vals.length ? Math.min(...vals) : null, count };
}

/** fast.com computeUnloadedLatency: min over workers of their p10. */
export function unloadedLatency(latencyMeasurements) {
  const lists = Object.values(latencyMeasurements);
  let count = 0;
  for (const l of lists) count += l.length;
  const vals = lists.map((l) => percentile(l, 0.1)).filter((v) => Number.isFinite(v));
  return { value: vals.length ? Math.min(...vals) : null, count };
}

// ============================================================================ Wisp v1 packets
// Packet: u8 type, u32 LE stream id, payload.

export const PACKET = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 };
export const STREAM_TCP = 0x01;
export const CLOSE_VOLUNTARY = 0x02;
const textEncoder = new TextEncoder();

function packet(type, streamId, payloadLen) {
  const buf = new Uint8Array(5 + payloadLen);
  buf[0] = type;
  new DataView(buf.buffer).setUint32(1, streamId >>> 0, true);
  return buf;
}

/** CONNECT: u8 stream type, u16 LE port, UTF-8 hostname (a literal IP is fine). */
export function encodeConnect(streamId, hostname, port, streamType = STREAM_TCP) {
  const host = textEncoder.encode(hostname);
  const buf = packet(PACKET.CONNECT, streamId, 3 + host.length);
  buf[5] = streamType;
  new DataView(buf.buffer).setUint16(6, port, true);
  buf.set(host, 8);
  return buf;
}

/** DATA: raw bytes (copied into a fresh packet). */
export function encodeData(streamId, bytes) {
  if (bytes.length > MAX_DATA_PAYLOAD) throw new RangeError("Wisp DATA payload too large");
  const buf = packet(PACKET.DATA, streamId, bytes.length);
  buf.set(bytes, 5);
  return buf;
}

/** CONTINUE: u32 LE buffer remaining (the server sends these; encoded here for tests). */
export function encodeContinue(streamId, remaining) {
  const buf = packet(PACKET.CONTINUE, streamId, 4);
  new DataView(buf.buffer).setUint32(5, remaining >>> 0, true);
  return buf;
}

/** CLOSE: u8 reason. */
export function encodeClose(streamId, reason = CLOSE_VOLUNTARY) {
  const buf = packet(PACKET.CLOSE, streamId, 1);
  buf[5] = reason;
  return buf;
}

/** Decode one packet (an ArrayBuffer or Uint8Array holding exactly one). `payload` is a view, not a copy. */
export function decodePacket(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 5) throw new RangeError("Wisp packet too short");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pkt = { type: u8[0], streamId: view.getUint32(1, true), payload: u8.subarray(5) };
  if (pkt.type === PACKET.CONTINUE) {
    if (u8.length < 9) throw new RangeError("Wisp CONTINUE too short");
    pkt.remaining = view.getUint32(5, true);
  } else if (pkt.type === PACKET.CLOSE) {
    pkt.reason = u8.length > 5 ? u8[5] : 0;
  } else if (pkt.type === PACKET.CONNECT && u8.length >= 8) {
    pkt.streamType = u8[5];
    pkt.port = view.getUint16(6, true);
    pkt.hostname = new TextDecoder().decode(u8.subarray(8));
  }
  return pkt;
}

// UPLOAD_CHUNK random bytes, made once: upload bodies are this repeated (no compression anywhere on
// the path, but random keeps it honest if some hop ever compresses).
let randomChunk = null;
function getRandomChunk() {
  if (!randomChunk) {
    randomChunk = new Uint8Array(UPLOAD_CHUNK);
    for (let i = 0; i < randomChunk.length; i += 65536) {
      crypto.getRandomValues(randomChunk.subarray(i, Math.min(i + 65536, randomChunk.length)));
    }
  }
  return randomChunk;
}

// ============================================================================ Wisp v1 client

class WispStream {
  constructor(conn, id, window) {
    this.conn = conn;
    this.id = id;
    this.window = window;   // DATA packets we may still send before the next CONTINUE
    this.open = true;
    this.queue = [];        // packets waiting for window
    this.ondata = null;     // (Uint8Array view) => void
    this.onclose = null;    // (reason) => void
    this.onwritable = null; // () => void, after a CONTINUE opened the window
    this._chunkPacket = null;
  }

  /** Send bytes as one DATA packet now if the window allows, else queue it (order is kept). */
  write(bytes) {
    if (!this.open) throw new Error("Wisp stream is closed");
    const pkt = encodeData(this.id, bytes);
    if (this.window > 0 && this.queue.length === 0) this._send(pkt);
    else this.queue.push(pkt);
  }

  /** True when a DATA packet may go out now. */
  writable() {
    return this.open && this.window > 0 && this.queue.length === 0;
  }

  /** A full-size upload DATA packet for this stream (random payload), built once and reused:
   *  WebSocket.send copies what it's given. */
  chunkPacket() {
    if (!this._chunkPacket) this._chunkPacket = encodeData(this.id, getRandomChunk());
    return this._chunkPacket;
  }

  /** Send an already encoded DATA packet (the caller checked writable()). */
  _send(pkt) {
    this.window--;
    this.conn._send(pkt);
  }

  _continue(remaining) {
    this.window = remaining;
    while (this.window > 0 && this.queue.length > 0) this._send(this.queue.shift());
    if (this.window > 0 && this.onwritable) this.onwritable();
  }

  close(reason = CLOSE_VOLUNTARY) {
    if (!this.open) return;
    this.open = false;
    this.queue.length = 0;
    this.conn.streams.delete(this.id);
    if (!this.conn.closed) this.conn._send(encodeClose(this.id, reason));
  }

  _closed(reason) {
    if (!this.open) return;
    this.open = false;
    this.queue.length = 0;
    if (this.onclose) this.onclose(reason);
  }
}

/**
 * What both transports share: the streams, the stream-0 CONTINUE that makes the connection ready
 * (every new stream's initial send window, in packets), and the packet dispatch. A subclass opens
 * the transport, calls _packet() with each Wisp packet it receives, sends with _send(), and reports
 * the bytes it has been given but the browser has not yet taken in `bufferedAmount`.
 */
class WispSession {
  constructor(url) {
    this.url = url;
    this.streams = new Map();
    this.nextId = 1;
    this.initialWindow = 0;
    this.ready = false;
    this.closed = false;
    this.onclose = null;
    this._ready = null;
  }

  createStream(hostname, port) {
    if (this.closed || !this.ready) throw new Error("Wisp connection is not open");
    const id = this.nextId++;
    const stream = new WispStream(this, id, this.initialWindow);
    this.streams.set(id, stream);
    this._send(encodeConnect(id, hostname, port));
    return stream;
  }

  /** One whole Wisp packet (an ArrayBuffer, or a Uint8Array view of exactly one). */
  _packet(data) {
    let pkt;
    try {
      pkt = decodePacket(data);
    } catch {
      return;
    }
    if (pkt.streamId === 0) {
      if (pkt.type === PACKET.CONTINUE) {
        this.initialWindow = pkt.remaining;
        if (!this.ready) {
          this.ready = true;
          this._ready();
        }
      }
      return;  // a CLOSE on stream 0 is followed by the transport closing
    }
    const stream = this.streams.get(pkt.streamId);
    if (!stream) return;
    if (pkt.type === PACKET.DATA) {
      if (stream.ondata) stream.ondata(pkt.payload);
    } else if (pkt.type === PACKET.CONTINUE) {
      stream._continue(pkt.remaining);
    } else if (pkt.type === PACKET.CLOSE) {
      this.streams.delete(pkt.streamId);
      stream._closed(pkt.reason);
    }
  }

  _closed() {
    if (this.closed && this.streams.size === 0) return;
    this.closed = true;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const s of streams) s._closed(0x03);
    if (this.onclose) {
      const cb = this.onclose;
      this.onclose = null;
      cb();
    }
  }
}

/**
 * One WebSocket to a Wisp v1 server. No subprotocol: on holyWisp that selects v1, and the server
 * opens with a CONTINUE on stream 0 carrying every new stream's initial send window (packets).
 */
export class WispConnection extends WispSession {
  constructor(url, { WebSocket: WS = globalThis.WebSocket } = {}) {
    super(url);
    this.transport = "websocket";
    this.WS = WS;
    this.ws = null;
  }

  open(timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new this.WS(this.url);
      } catch (e) {
        this.closed = true;
        reject(e);
        return;
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        reject(new Error("Wisp handshake timed out"));
        this.close();
      }, timeoutMs);
      this._ready = () => {
        clearTimeout(timer);
        resolve(this);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") this._packet(ev.data);
      };
      ws.onerror = () => {};  // a close event follows
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const wasReady = this.ready;
        this._closed();
        if (!wasReady) reject(new Error(`Wisp WebSocket closed (${ev && ev.code})`));
      };
    });
  }

  get bufferedAmount() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  close() {
    if (this.closed) return;
    try {
      this.ws && this.ws.close();
    } catch {
      /* already closing */
    }
    this._closed();
  }

  _send(bytes) {
    this.ws.send(bytes);
  }
}

function base64Bytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * One WebTransport session to holyWisp's WebTransport listener (Wisp over HTTP/3, on QUIC), the
 * same Wisp v1 as on a WebSocket: no `protocols` (that would select v2), one bidirectional stream
 * (the Wisp stream) carrying Wisp packets back to back, each behind its length as a u32 LE, and the
 * server's stream-0 CONTINUE first. Datagrams carry only UDP stream DATA, which a speed test never
 * opens, so they are not read.
 *
 * `hashes` are /webtransport.json's (`[{algorithm: "sha-256", value: <base64>}]`), passed as
 * serverCertificateHashes for a self-signed listener; with none the browser checks the certificate
 * like any https site's.
 *
 * bufferedAmount is the payload of every write() whose promise has not resolved yet. A write
 * resolves once the browser has taken the bytes out of the stream's queue into its network stack
 * (Chrome: written into the data pipe to the network service, the same hand-off at which a
 * WebSocket's bufferedAmount stops counting them), so "sent minus bufferedAmount" means what it
 * means on a WebSocket. It is counted here, not read from writer.desiredSize, because the queue's
 * high-water mark is the browser's choice (and counts chunks, not bytes, in some).
 */
export class WtConnection extends WispSession {
  constructor(url, { WebTransport: WT = globalThis.WebTransport, hashes = [] } = {}) {
    super(url);
    this.transport = "webtransport";
    this.WT = WT;
    this.hashes = hashes;
    this.wt = null;
    this.writer = null;
    this._buffered = 0;
    this._fail = null;
    this._hold = null;  // a packet that straddles reads: its bytes so far (length prefix included)
    this._held = 0;
  }

  open(timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (typeof this.WT !== "function") {
        this.closed = true;
        reject(new Error("this browser has no WebTransport"));
        return;
      }
      const opts = {};
      if (this.hashes.length) {
        opts.serverCertificateHashes = this.hashes.map((h) => ({ algorithm: h.algorithm, value: base64Bytes(h.value) }));
      }
      let wt;
      try {
        wt = new this.WT(this.url, opts);
      } catch (e) {
        this.closed = true;
        reject(e);
        return;
      }
      this.wt = wt;
      let timer = null;
      const fail = (err) => {
        clearTimeout(timer);
        this._fail = null;
        const wasReady = this.ready;
        this.close();
        if (!wasReady) reject(err);
      };
      this._fail = fail;
      timer = setTimeout(() => fail(new Error("WebTransport handshake timed out")), timeoutMs);
      this._ready = () => {
        clearTimeout(timer);
        resolve(this);
      };
      Promise.resolve(wt.closed).then(
        () => fail(new Error("WebTransport session closed")),
        (e) => fail(new Error((e && e.message) || "WebTransport failed")),
      );
      (async () => {
        await wt.ready;
        const bidi = await wt.createBidirectionalStream();
        if (this.closed) return;
        this.writer = bidi.writable.getWriter();
        const reader = bidi.readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.closed) break;
          this._feed(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
        if (!this.closed) fail(new Error("the Wisp stream ended"));
      })().catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
    });
  }

  get bufferedAmount() {
    return this._buffered;
  }

  close() {
    if (this.closed) return;
    this._closed();
    if (this._fail) this._fail(new Error("closed"));  // an open() still waiting rejects now
    try {
      if (this.wt) this.wt.close({ closeCode: 0, reason: "" });
    } catch {
      /* already closed */
    }
  }

  _send(bytes) {
    const frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, bytes.length, true);
    frame.set(bytes, 4);
    const n = bytes.length;
    this._buffered += n;
    this.writer.write(frame).then(
      () => {
        this._buffered -= n;
      },
      () => {
        this._buffered -= n;
        this.close();
      },
    );
  }

  /** Split what the Wisp stream delivered into packets. Whole packets are handed on as views of
   *  the read; one that straddles reads is gathered in a buffer of its own. */
  _feed(u8) {
    let i = 0;
    const n = u8.length;
    if (this._hold) {
      if (this._held < 4) {
        const take = Math.min(4 - this._held, n);
        this._hold.set(u8.subarray(0, take), this._held);
        this._held += take;
        i = take;
        if (this._held < 4) return;
        const len = new DataView(this._hold.buffer).getUint32(0, true);
        if (len > WT_MAX_PACKET) return this._broken();
        const full = new Uint8Array(4 + len);
        full.set(this._hold.subarray(0, 4));
        this._hold = full;
      }
      const take = Math.min(this._hold.length - this._held, n - i);
      this._hold.set(u8.subarray(i, i + take), this._held);
      this._held += take;
      i += take;
      if (this._held < this._hold.length) return;
      const pkt = this._hold.subarray(4);
      this._hold = null;
      this._held = 0;
      this._packet(pkt);
      if (this.closed) return;
    }
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (n - i >= 4) {
      const len = view.getUint32(i, true);
      if (len > WT_MAX_PACKET) return this._broken();
      if (n - i - 4 < len) break;
      this._packet(u8.subarray(i + 4, i + 4 + len));
      if (this.closed) return;
      i += 4 + len;
    }
    if (i < n) {
      const rest = n - i;
      let size = 4;
      if (rest >= 4) size = 4 + view.getUint32(i, true);
      this._hold = new Uint8Array(size);
      this._hold.set(u8.subarray(i));
      this._held = rest;
    }
  }

  _broken() {
    this._hold = null;
    this._held = 0;
    if (this._fail) this._fail(new Error("broken Wisp stream (packet length)"));
    else this.close();
  }
}

/**
 * Which transport a run may use, from /webtransport.json as the relay serves it
 * (`{url, hashes: [{algorithm, value}]}`), or null if it offers none. An empty url is holyWisp's
 * default: the relay's own host and port, over https. Only https:// URLs and sha-256 hashes.
 */
export function webtransportConfig(json, wispUrl) {
  if (!json || typeof json !== "object" || typeof json.url !== "string" || !Array.isArray(json.hashes)) return null;
  let url = json.url;
  if (url === "") {
    let u;
    try {
      u = new URL(wispUrl);
    } catch {
      return null;
    }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    url = `https://${u.host}/`;
  }
  if (!/^https:\/\/[^/]/i.test(url)) return null;
  const hashes = json.hashes
    .filter((h) => h && h.algorithm === "sha-256" && typeof h.value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(h.value))
    .map((h) => ({ algorithm: h.algorithm, value: h.value }));
  return { url, hashes };
}

/** Where a relay describes its WebTransport listener: /webtransport.json at the root of the origin
 *  that serves its WebSocket (ws://h/... → http://h/webtransport.json), or null. */
export function webtransportConfigUrl(wispUrl) {
  let u;
  try {
    u = new URL(wispUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}/webtransport.json`;
}

/**
 * The run's connections (WebSockets, or WebTransport sessions: one each way, never mixed). Each
 * worker leases one exclusively (one connection per worker, as many browser ⇄ box flows as fast.com
 * has to its OCAs) and gives it back when it stops, so the next phase reuses it. warm(n) opens n up
 * front, before any load.
 *
 * Why: Chrome holds a new WebSocket's handshake to an endpoint for seconds (5–15 s measured, the
 * relay answering in 1–2 ms) while other sockets to it are saturated with uploads. Opening a socket
 * per ramp worker under load left those workers idle (no snapshots), and the 10 s handshake
 * timeout then restarted the attempt, resetting testTime, over and over.
 *
 * `connect` makes a new, unopened connection (default: a WispConnection to `url`).
 */
export class WispPool {
  constructor(url, { WebSocket: WS = globalThis.WebSocket, connect = null } = {}) {
    this.url = url;
    this.connect = connect || (() => new WispConnection(url, { WebSocket: WS }));
    this.idle = [];        // {conn, opened: Promise<conn>}, open or still opening
    this.all = new Set();  // every live connection, leased or idle
    this.closed = false;
  }

  _open() {
    const conn = this.connect();
    this.all.add(conn);
    const opened = conn.open().then(
      () => conn,
      (e) => {
        this.all.delete(conn);
        conn.close();
        throw e;
      },
    );
    opened.catch(() => {});  // an idle entry may fail before anyone waits on it
    return { conn, opened };
  }

  /** Take an already open connection in as an idle one. */
  adopt(conn) {
    if (this.closed) {
      conn.close();
      return;
    }
    this.all.add(conn);
    this.idle.push({ conn, opened: Promise.resolve(conn) });
  }

  _prune() {
    this.idle = this.idle.filter((e) => {
      if (!e.conn.closed) return true;
      this.all.delete(e.conn);
      return false;
    });
  }

  /** Open connections (in the background) until there are `n` in all, leased ones included. */
  warm(n) {
    if (this.closed) return;
    this._prune();
    while (this.all.size < n) this.idle.push(this._open());
  }

  /** Lease a connection: an open idle one, else one still opening, else a new one. */
  async acquire() {
    if (this.closed) throw new Error("stopped");
    this._prune();
    let i = this.idle.findIndex((e) => e.conn.ready);
    if (i < 0 && this.idle.length) i = 0;
    const entry = i >= 0 ? this.idle.splice(i, 1)[0] : this._open();
    const conn = await entry.opened;
    if (this.closed) {
      conn.close();
      throw new Error("stopped");
    }
    return conn;
  }

  /** Give a leased connection back (its streams already closed). A closed one is dropped. */
  release(conn) {
    if (this.closed || conn.closed) {
      this.all.delete(conn);
      conn.close();
      return;
    }
    this.idle.push({ conn, opened: Promise.resolve(conn) });
  }

  close() {
    this.closed = true;
    for (const c of this.all) c.close();
    this.all.clear();
    this.idle = [];
  }
}

// ============================================================================ HTTP/1.1 responses

const S_HEAD = 0;
const S_LENGTH = 1;
const S_CLOSE = 2;
const S_CHUNK_SIZE = 3;
const S_CHUNK_DATA = 4;
const S_CHUNK_END = 5;
const S_TRAILER = 6;
const MAX_HEAD = 65536;

function latin1(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
  }
  return s;
}

/**
 * Incremental HTTP/1.1 response parser. Body bytes are counted, never kept.
 * Callbacks: onhead(head), onbody(byteCount), oncomplete(head). `head` is
 * {version, status, statusText, headers (lower-case names), keepAlive}.
 * After a response completes it starts on the next one (keep-alive; extra bytes in the same chunk
 * are parsed as the next response). Interim 1xx responses are skipped.
 */
export class HttpResponseParser {
  constructor() {
    this.onhead = null;
    this.onbody = null;
    this.oncomplete = null;
    this._resetMessage();
  }

  _resetMessage() {
    this.state = S_HEAD;
    this.headParts = [];
    this.headLen = 0;
    this.lineLen = 0;       // non-CR bytes on the current head line
    this.sawContent = false;
    this.head = null;
    this.remaining = 0;
    this.line = "";
  }

  /** True between responses (nothing of a new one received yet). */
  idle() {
    return this.state === S_HEAD && this.headLen === 0;
  }

  push(u8) {
    let i = 0;
    const n = u8.length;
    while (i < n) {
      switch (this.state) {
        case S_HEAD: {
          let end = -1;
          let j = i;
          for (; j < n; j++) {
            const b = u8[j];
            if (b === 10) {
              // An empty line ends the head; empty lines before the status line are skipped.
              if (this.lineLen === 0 && this.sawContent) {
                end = j;
                break;
              }
              this.lineLen = 0;
            } else if (b !== 13) {
              this.lineLen++;
              this.sawContent = true;
            }
          }
          const stop = end >= 0 ? end + 1 : n;
          this.headParts.push(u8.slice(i, stop));
          this.headLen += stop - i;
          if (this.headLen > MAX_HEAD) throw new Error("HTTP response head too large");
          i = stop;
          if (end >= 0) this._parseHead();
          break;
        }
        case S_LENGTH:
        case S_CHUNK_DATA: {
          const take = Math.min(this.remaining, n - i);
          i += take;
          this.remaining -= take;
          if (take > 0 && this.onbody) this.onbody(take);
          if (this.remaining === 0) {
            if (this.state === S_LENGTH) this._complete();
            else this.state = S_CHUNK_END;
          }
          break;
        }
        case S_CLOSE: {
          const take = n - i;
          i = n;
          if (this.onbody) this.onbody(take);
          break;
        }
        default: {
          // Line-based states: chunk size, CRLF after chunk data, trailers.
          let j = i;
          while (j < n && u8[j] !== 10) j++;
          this.line += latin1(u8.subarray(i, j));
          if (this.line.length > 8192) throw new Error("HTTP chunk line too long");
          if (j === n) {
            i = n;
            break;
          }
          i = j + 1;
          const line = this.line.replace(/\r$/, "");
          this.line = "";
          if (this.state === S_CHUNK_SIZE) {
            const hex = line.split(";")[0].trim();
            if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("bad HTTP chunk size");
            const size = parseInt(hex, 16);
            if (size === 0) {
              this.state = S_TRAILER;
            } else {
              this.remaining = size;
              this.state = S_CHUNK_DATA;
            }
          } else if (this.state === S_CHUNK_END) {
            if (line !== "") throw new Error("bad HTTP chunk terminator");
            this.state = S_CHUNK_SIZE;
          } else if (line === "") {
            this._complete();  // end of trailers
          }
        }
      }
    }
  }

  /** The connection ended. Returns true if that completed a close-delimited response; throws if a
   *  response was cut short. */
  finish() {
    if (this.state === S_CLOSE) {
      this._complete();
      return true;
    }
    if (this.idle()) return false;
    throw new Error("connection closed mid-response");
  }

  _parseHead() {
    const total = new Uint8Array(this.headLen);
    let off = 0;
    for (const p of this.headParts) {
      total.set(p, off);
      off += p.length;
    }
    this.headParts = [];
    this.headLen = 0;
    this.lineLen = 0;
    this.sawContent = false;
    const lines = latin1(total).split(/\r?\n/);
    while (lines.length && lines[0] === "") lines.shift();
    const m = /^HTTP\/(\d)\.(\d)\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] || "");
    if (!m) throw new Error("bad HTTP status line");
    const headers = {};
    for (let k = 1; k < lines.length; k++) {
      const line = lines[k];
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }
    const version = Number(m[1]) + Number(m[2]) / 10;
    const status = Number(m[3]);
    if (status >= 100 && status < 200 && status !== 101) return;  // interim: wait for the real one
    const conn = (headers.connection || "").toLowerCase();
    const head = {
      version,
      status,
      statusText: m[4] || "",
      headers,
      keepAlive: version >= 1.1 ? !/\bclose\b/.test(conn) : /\bkeep-alive\b/.test(conn),
    };
    this.head = head;
    if (this.onhead) this.onhead(head);
    if (status === 204 || status === 304) {
      this._complete();
    } else if (/\bchunked\b/i.test(headers["transfer-encoding"] || "")) {
      this.state = S_CHUNK_SIZE;
    } else if ("content-length" in headers) {
      const cl = Number(headers["content-length"]);
      if (!Number.isSafeInteger(cl) || cl < 0) throw new Error("bad Content-Length");
      this.remaining = cl;
      if (cl === 0) this._complete();
      else this.state = S_LENGTH;
    } else {
      head.keepAlive = false;  // the body runs to the end of the connection
      this.state = S_CLOSE;
    }
  }

  _complete() {
    const head = this.head;
    this._resetMessage();
    if (this.oncomplete) this.oncomplete(head);
  }
}

// ============================================================================ HTTP/1.1 client

/**
 * One keep-alive HTTP/1.1 connection to `target` over a Wisp TCP stream, one request at a time.
 * A new stream is opened when there is none, after `Connection: close`, or when the server closed
 * it. `getConn()` returns (a promise of) the open WispConnection to use.
 *
 * request() resolves {ok, status, headers, start, firstByte, end, bytes}: `start` is when the
 * request was handed to the socket and `firstByte` when the first response byte arrived (their
 * difference is the latency sample). It rejects on network failure or timeout.
 * onProgress(n) reports body bytes as they arrive (GET) or as they leave the connection (POST:
 * bytes handed to it minus its bufferedAmount; WtConnection says what that is on WebTransport).
 */
export class HttpConnection {
  constructor(getConn, target, now = () => performance.now()) {
    this.getConn = getConn;
    this.target = target;   // {connectHost, port, hostHeader}
    this.now = now;
    this.stream = null;
    this.conn = null;
    this.parser = null;
    this.req = null;
    this.closed = false;
  }

  async request({ method = "GET", path, bodySize = 0, onProgress = null }) {
    if (this.req) throw new Error("HTTP connection busy");
    if (this.closed) throw new Error("HTTP connection closed");
    const conn = await this.getConn();
    if (this.closed) throw new Error("HTTP connection closed");
    return new Promise((resolve, reject) => {
      try {
        if (!this.stream || !this.stream.open || this.conn !== conn) this._openStream(conn);
      } catch (e) {
        reject(e);
        return;
      }
      const t = this.target;
      let head = `${method} ${path} HTTP/1.1\r\nHost: ${t.hostHeader}\r\nAccept: */*\r\nConnection: keep-alive\r\n`;
      if (method !== "GET") {
        if (bodySize > 0) head += "Content-Type: application/octet-stream\r\n";
        head += `Content-Length: ${bodySize}\r\n`;
      }
      head += "\r\n";
      const req = {
        method,
        resolve,
        reject,
        onProgress,
        start: this.now(),
        firstByte: 0,
        bytes: 0,
        head: null,
        lastActivity: 0,
        watchdog: null,
        upload: bodySize > 0 ? { size: bodySize, sent: 0, reported: 0, timer: null, poll: null } : null,
      };
      req.lastActivity = req.start;
      this.req = req;
      try {
        this.stream.write(textEncoder.encode(head));
      } catch (e) {
        this._fail(e);
        return;
      }
      // fast.com: 9 s without progress, 60 s in all. One coarse timer, not one per packet.
      req.watchdog = setInterval(() => {
        const t = this.now();
        if (t - req.lastActivity > REQUEST_IDLE_TIMEOUT_MS || t - req.start > REQUEST_TOTAL_TIMEOUT_MS) {
          if (this.req === req) this._fail(new Error("request timed out"));
        }
      }, 1000);
      if (req.upload) {
        this.stream.onwritable = () => this._pump();
        req.upload.poll = setInterval(() => this.pollUpload(), 25);
        this._pump();
      }
    });
  }

  /** Report upload bytes that have left the connection (WebSocket or WebTransport) since the last call. */
  pollUpload() {
    const req = this.req;
    if (!req || !req.upload || !this.conn) return;
    const u = req.upload;
    const left = Math.max(0, u.sent - this.conn.bufferedAmount);
    if (left > u.reported) {
      const d = left - u.reported;
      u.reported = left;
      req.lastActivity = this.now();
      if (req.onProgress) req.onProgress(d);
    }
  }

  close() {
    this.closed = true;
    if (this.req) this._fail(new Error("stopped"));
    if (this.stream) this.stream.close();
    this.stream = null;
  }

  _openStream(conn) {
    if (this.stream && this.stream.open) this.stream.close();
    const s = conn.createStream(this.target.connectHost, this.target.port);
    const parser = new HttpResponseParser();
    this.stream = s;
    this.conn = conn;
    this.parser = parser;
    parser.onhead = (head) => {
      if (this.req) this.req.head = head;
    };
    parser.onbody = (n) => {
      const req = this.req;
      if (!req) return;
      req.bytes += n;
      if (!req.upload && req.onProgress) req.onProgress(n);
    };
    parser.oncomplete = (head) => this._complete(head);
    s.ondata = (u8) => {
      if (s !== this.stream) return;
      const req = this.req;
      if (req) {
        const t = this.now();
        if (!req.firstByte) req.firstByte = t;
        req.lastActivity = t;
      }
      try {
        parser.push(u8);
      } catch (e) {
        if (this.req) this._fail(e);
        else this._dropStream();
      }
    };
    s.onclose = (reason) => {
      if (s !== this.stream) return;
      this.stream = null;
      if (!this.req) return;
      try {
        parser.finish();  // completes a close-delimited response
      } catch {
        /* cut short: fails below */
      }
      if (this.req) this._fail(new Error(`connection closed (Wisp reason 0x${reason.toString(16)})`));
    };
  }

  _pump() {
    const req = this.req;
    if (!req || !req.upload) return;
    const u = req.upload;
    const s = this.stream;
    clearTimeout(u.timer);
    u.timer = null;
    if (!s) return;
    while (u.sent < u.size && s.writable() && this.conn.bufferedAmount < MAX_BUFFERED) {
      const n = Math.min(UPLOAD_CHUNK, u.size - u.sent);
      s._send(n === UPLOAD_CHUNK ? s.chunkPacket() : encodeData(s.id, getRandomChunk().subarray(0, n)));
      u.sent += n;
    }
    // Window open but the socket is full: poll until it drains (browsers have no drain event).
    // Window closed: the next CONTINUE calls onwritable.
    if (u.sent < u.size && s.writable()) u.timer = setTimeout(() => this._pump(), 4);
  }

  _complete(head) {
    const req = this.req;
    if (!req) return;
    this._clearReq(req);
    // Done with this stream if the server says so, or if it answered before the whole upload body
    // went out (the rest would be read as the next request).
    if (!head.keepAlive || (req.upload && req.upload.sent < req.upload.size)) this._dropStream();
    const status = head.status;
    const ok = req.method === "GET" ? status === 200 || status === 304 : (status >= 200 && status < 300) || status === 304;
    if (ok && req.upload && req.onProgress) {
      // Like XHR's onload: whatever was not reported yet arrived.
      const rest = req.upload.size - req.upload.reported;
      req.upload.reported = req.upload.size;
      if (rest > 0) req.onProgress(rest);
    }
    req.resolve({
      ok,
      status,
      headers: head.headers,
      start: req.start,
      firstByte: req.firstByte || this.now(),
      end: this.now(),
      bytes: req.bytes,
    });
  }

  _clearReq(req) {
    clearInterval(req.watchdog);
    if (req.upload) {
      clearTimeout(req.upload.timer);
      clearInterval(req.upload.poll);
    }
    if (this.stream) this.stream.onwritable = null;
    this.req = null;
  }

  _dropStream() {
    if (this.stream) this.stream.close();
    this.stream = null;
  }

  _fail(err) {
    const req = this.req;
    if (!req) return;
    this._clearReq(req);
    this._dropStream();
    req.reject(err);
  }
}

// ============================================================================ test servers

/**
 * A test server, from a range base URL ending in `/range/` before any query, e.g.
 * `http://203.0.113.7/speedtest/range/?c=...` (fast.com: the API's URL with `speedtest` replaced by
 * `speedtest/range/`). path("0-1000") gives the request target `/speedtest/range/0-1000?c=...`.
 */
export function makeTarget(rangeBase, { label, addr, connectHost, port, hostHeader } = {}) {
  const u = new URL(rangeBase);
  if (u.protocol !== "http:") throw new Error(`test server must be plain http: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const afterScheme = rangeBase.indexOf("//") + 2;
  const slash = rangeBase.indexOf("/", afterScheme);
  const rel = slash >= 0 ? rangeBase.slice(slash) : "/";
  const oca = rangeBase.slice(afterScheme, slash >= 0 ? slash : undefined);  // fast.com: url.split("/")[2]
  return {
    url: rangeBase,
    label: label || host,
    addr: addr || host,
    connectHost: connectHost || host,
    port: port || Number(u.port) || 80,
    hostHeader: hostHeader || u.host,
    oca,
    site: oca.split(".")[2],  // fast.com's "site" (third label); for a literal IPv4 the third octet
    path: (range) => rel.replace("/range/", `/range/${range}`),
  };
}

/** fast.com url_getter: round-robin over the good targets, bad-server bookkeeping, refresh. */
class UrlGetter {
  constructor(targets, refresh, now) {
    this.all = targets;
    this.refreshFn = refresh;  // async () => targets, or null
    this.now = now;
    this.refreshing = null;
    this.lastRefresh = now();
    this.reset();
  }

  reset() {
    this.badUrls = new Set();
    this.ocaFailures = {};
    this.siteFailures = {};
    this._select(this.all);
  }

  isBad(t) {
    return this.badUrls.has(t.url) || (this.ocaFailures[t.oca] || 0) >= 2 || (this.siteFailures[t.site] || 0) >= 3;
  }

  reportBad(t) {
    this.badUrls.add(t.url);
    this.ocaFailures[t.oca] = (this.ocaFailures[t.oca] || 0) + 1;
    if (this.ocaFailures[t.oca] === 1 && t.site !== undefined) {
      this.siteFailures[t.site] = (this.siteFailures[t.site] || 0) + 1;
    }
    this.urls = this.urls.filter((u) => !this.isBad(u));
  }

  _select(targets) {
    const good = targets.filter((t) => !this.isBad(t));
    this.urls = good.length ? good : targets.slice();  // all bad: use them all anyway (fast.com)
    this.ind = 0;
  }

  async next() {
    // fast.com refreshes the list whenever fewer than 3 good targets remain. We do it only when a
    // refresh is possible (netflix mode), at most every 10 s, one at a time.
    if (this.urls.length < 3 && this.refreshFn && this.now() - this.lastRefresh > 10000) {
      if (!this.refreshing) {
        this.refreshing = this.refreshFn()
          .then((targets) => {
            if (targets.length) {
              this.all = targets;
              this._select(targets);
            }
          })
          .catch(() => {})
          .finally(() => {
            this.lastRefresh = this.now();
            this.refreshing = null;
          });
      }
      await this.refreshing;
    }
    if (this.urls.length === 0) this.urls = this.all.slice();
    if (this.urls.length === 0) throw new Error("No test servers");
    this.ind = (this.ind + 1) % this.urls.length;
    return this.urls[this.ind];
  }
}

// ============================================================================ libcurl.js (netflix mode)

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const libcurlCache = new Map();  // base URL → Promise<libcurl>

/**
 * Load libcurl.js 0.7.4 from `base`: fetch libcurl.mjs and libcurl.wasm, check their hashes with
 * WebCrypto (dynamic import() takes no SRI), then import/load them from blob: URLs.
 */
export function loadLibcurl(base = LIBCURL_BASE, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!base.endsWith("/")) base += "/";
  let p = libcurlCache.get(base);
  if (!p) {
    p = (async () => {
      const get = async (name) => {
        const r = await fetchImpl(base + name, { credentials: "omit" });
        if (!r.ok) throw new Error(`libcurl.js: ${name}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const [mjs, wasm] = await Promise.all([get("libcurl.mjs"), get("libcurl.wasm")]);
      const [mjsHash, wasmHash] = await Promise.all([
        crypto.subtle.digest("SHA-384", mjs),
        crypto.subtle.digest("SHA-256", wasm),
      ]);
      if (toBase64(new Uint8Array(mjsHash)) !== LIBCURL_MJS_SHA384_B64) throw new Error("libcurl.mjs failed its integrity check");
      if (toHex(new Uint8Array(wasmHash)) !== LIBCURL_WASM_SHA256_HEX) throw new Error("libcurl.wasm failed its integrity check");
      const mjsUrl = URL.createObjectURL(new Blob([mjs], { type: "text/javascript" }));
      const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
      try {
        let mod;
        try {
          mod = await import(/* @vite-ignore */ mjsUrl);
        } catch {
          // Runtimes that can't import blob: URLs (Node, for the test harness) can import a
          // data: URL of the same, already verified, bytes. Browsers take the blob: path.
          mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${toBase64(mjs)}`);
        }
        const libcurl = mod.libcurl;
        await libcurl.load_wasm(wasmUrl);
        return libcurl;
      } finally {
        URL.revokeObjectURL(mjsUrl);
        URL.revokeObjectURL(wasmUrl);
      }
    })();
    p.catch(() => libcurlCache.delete(base));
    libcurlCache.set(base, p);
  }
  return p;
}

/** Turn an api.fast.com v2 answer into test servers. */
export function netflixTargets(json) {
  const out = [];
  for (const t of (json && json.targets) || []) {
    if (!t || typeof t.url !== "string") continue;
    try {
      const loc = t.location || {};
      const label = [loc.city, loc.country].filter(Boolean).join(", ") || t.name;
      out.push(makeTarget(t.url.replace(/speedtest/, "speedtest/range/"), { label }));
    } catch {
      /* not plain http: skip */
    }
  }
  return out;
}

// ============================================================================ the tester
// A port of fast.com's tester for one test type ("download" | "upload" | "latency").

class Worker {
  constructor(ctx, target) {
    this.ctx = ctx;
    this.target = target;
    this.conn = null;
    this.connPromise = null;
    this.closed = false;
    this.timers = new Set();
    const getConn = () => this.getConn();
    this.data = new HttpConnection(getConn, target, ctx.now);  // the data requester
    this.ping = new HttpConnection(getConn, target, ctx.now);  // the pinger
  }

  /** The worker's own connection (WebSocket or WebTransport session), leased from the run's pool
   *  (again if it closed); the data and ping streams share it. */
  getConn() {
    if (this.closed) return Promise.reject(new Error("stopped"));
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    if (this.conn) {
      this.ctx.pool.release(this.conn);  // closed: dropped
      this.conn = null;
    }
    if (!this.connPromise) {
      this.connPromise = this.ctx.pool.acquire().then(
        (c) => {
          this.connPromise = null;
          if (this.closed) {
            this.ctx.pool.release(c);
            throw new Error("stopped");
          }
          this.conn = c;
          return c;
        },
        (e) => {
          this.connPromise = null;
          throw e;
        },
      );
    }
    return this.connPromise;
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.data.close();  // closes the worker's streams on the socket ...
    this.ping.close();
    if (this.conn) this.ctx.pool.release(this.conn);  // ... which the next worker may lease
    this.conn = null;
  }
}

/** Coalesces a worker's byte counts into progress measurements {bytes, start, end, time}. */
function createMeter(onMeasurement) {
  let pending = 0;
  let last = 0;
  return {
    /** A request starts: the next measurement starts here (fast.com lastProgressTime). */
    begin(t) {
      this.flush(t);
      last = t;
    },
    add(n, t) {
      pending += n;
      if (t - last >= PROGRESS_EVENT_MS) this.flush(t);
    },
    flush(t) {
      if (pending > 0) {
        onMeasurement({ bytes: pending, start: last, end: t, time: t - last });
        pending = 0;
        last = t;
      }
    },
  };
}

function runTester(ctx, type, urlGetter, onProgress) {
  const { now, opts } = ctx;
  const isLatency = type === "latency";
  const isUpload = type === "upload";
  const snap = createSnapshotter();
  const aggregate = createStableMovingAverage(5);
  const stopper = createStableDeltaStopper({ minDuration: 7, maxDuration: 30, stabilityDelta: 2, minStableMeasurements: 6 });

  let resolveRun, rejectRun;
  const promise = new Promise((res, rej) => {
    resolveRun = res;
    rejectRun = rej;
  });

  let running = false;
  let finished = false;
  let gen = 0;            // bumps on every stop: callbacks from an earlier attempt check it
  let attempt = 1;
  let tickTimer = null;
  let retryTimer = null;
  let nextWorkerId = 1;
  let totalBytes = 0;     // like fast.com stats.bytes: grows across attempts of this test
  let startTime, downloadStartTime, workers, workerMeasurements, latencyMeasurements;
  let progressMeasurements, activeWorkersCount, ocaCount;

  function stopAll() {
    running = false;
    gen++;
    clearTimeout(tickTimer);
    clearTimeout(retryTimer);
    if (workers) for (const w of workers.values()) w.close();
  }

  function reset() {
    if (running) stopAll();
    startTime = null;
    downloadStartTime = null;
    workers = new Map();
    workerMeasurements = {};
    latencyMeasurements = {};
    progressMeasurements = [];
    activeWorkersCount = 0;
    ocaCount = {};
    snap.reset();
  }

  function finish(result) {
    if (finished) return;
    finished = true;
    stopAll();
    resolveRun(result);
  }

  function fail(err) {
    if (finished) return;
    finished = true;
    stopAll();
    rejectRun(err);
  }

  /** fast.com test(attempt, error): reset, mark the failed server bad, start again (backoff). */
  function test(att, error) {
    if (finished) return;
    reset();
    attempt = att || 1;
    if (attempt > MAX_ATTEMPTS) {
      fail(error || new Error(`${type} test failed`));
      return;
    }
    running = true;
    if (error && error.target) urlGetter.reportBad(error.target);
    const myGen = gen;
    const begin = () => {
      if (gen !== myGen || !running) return;
      startTime = now();
      const n = isLatency ? Math.min(5, opts.connections.max) : opts.connections.min;
      for (let i = 0; i < n; i++) startNewWorker();
      tick();
    };
    if (attempt > 1) retryTimer = setTimeout(begin, Math.min(2 ** attempt, 200));
    else begin();
  }

  function startNewWorker() {
    activeWorkersCount += 1;
    const myGen = gen;
    urlGetter.next().then(
      (target) => {
        if (gen !== myGen || !running) return;
        if (downloadStartTime == null) downloadStartTime = now();  // testTime counts from here
        startTestWorker(nextWorkerId++, target, myGen);
      },
      (err) => {
        if (gen !== myGen || !running) return;
        test(attempt + 1, err);
      },
    );
  }

  function startTestWorker(id, target, myGen) {
    const worker = new Worker(ctx, target);
    workers.set(id, worker);
    workerMeasurements[id] = [];
    latencyMeasurements[id] = [];
    const alive = () => running && gen === myGen && workers.get(id) === worker;
    worker.meter = createMeter((m) => {
      workerMeasurements[id].push(m);
      totalBytes += m.bytes;
    });
    // The pinger: range/0-0 (fast.com sends it as a body-less POST), timed request → first byte.
    // Loaded: about once a second (1000 - last latency ms between). Unloaded test: back to back.
    const ping = () => {
      if (!alive()) return;
      const done = (latency) => {
        if (!alive()) return;
        let delay;
        if (isLatency) delay = latency === undefined ? FAILED_REQUEST_BACKOFF_MS : 0;
        else delay = latency === undefined ? LATENCY_FREQ_MS : Math.max(LATENCY_FREQ_MS - latency, 0);
        worker.later(ping, delay);
      };
      worker.ping.request({ method: "POST", path: target.path("0-0"), bodySize: 0 }).then(
        (res) => {
          if (!res.ok || !alive()) return done(undefined);
          const latency = res.firstByte - res.start;
          latencyMeasurements[id].push(latency);
          done(latency);
        },
        () => done(undefined),
      );
    };

    // The data requester: range/0-<size>, the next one sent as soon as one completes. The size is
    // 26214400 minus the requests already made to this OCA in this attempt (every worker's), so no
    // two requests are identical, the first ones of workers sharing a server included.
    const sendData = () => {
      if (!alive()) return;
      const made = ocaCount[target.oca] || 0;
      ocaCount[target.oca] = made + 1;
      const requestSize = MAX_PAYLOAD_BYTES - made;
      worker.meter.begin(now());
      worker.data
        .request({
          method: isUpload ? "POST" : "GET",
          path: target.path(`0-${requestSize}`),
          bodySize: isUpload ? requestSize : 0,
          onProgress: (n) => {
            if (alive()) worker.meter.add(n, now());
          },
        })
        .then(
          (res) => complete(res.ok, res.ok ? null : new Error(`HTTP ${res.status} from ${target.addr}`)),
          (err) => complete(false, err),
        );
    };

    const complete = (success, err) => {
      if (!alive()) return;
      worker.meter.flush(now());
      // A failure after this worker has moved data counts as a (partial) success.
      const partialSuccess = !success && workerMeasurements[id].length > 0;
      if (!success && !partialSuccess) {
        const e = new Error(`Could not ${isUpload ? "upload to" : "download from"} ${target.addr}: ${err ? err.message : "failed"}`);
        e.target = target;
        test(attempt + 1, e);
        return;
      }
      if (success) sendData();
      else worker.later(sendData, FAILED_REQUEST_BACKOFF_MS);
    };

    ping();
    if (!isLatency) sendData();
  }

  /** One progress tick (fast.com reportMetrics). */
  function tick() {
    if (!running) return;
    const t = now();
    const testTime = (t - (downloadStartTime ?? startTime)) / 1000;

    if (isLatency) {
      const r = unloadedLatency(latencyMeasurements);
      // fast.com has no upper bound here; we stop at duration.max so a dead path can't hang.
      if ((testTime > UNLOADED_MIN_S && r.count > UNLOADED_MIN_SAMPLES) || testTime > opts.duration.max) {
        if (r.value == null) {
          const e = new Error("No latency samples");
          test(attempt + 1, e);
        } else {
          finish({ value: r.value, count: r.count });
        }
        return;
      }
      onProgress({ value: r.value, count: r.count });
      tickTimer = setTimeout(tick, PROGRESS_MS);
      return;
    }

    for (const w of workers.values()) {
      if (isUpload) w.data.pollUpload();
      w.meter.flush(t);
    }
    const latest = snap.compute(workerMeasurements);
    const activeSnapshot = !!latest && latest.end - latest.start > 0;
    const snapshots = snap.all();
    let speed;
    let testComplete = false;
    if (activeSnapshot) {
      speed = aggregate(snapshots);
      testComplete = testTime > opts.duration.min && stopper({ testTime, progressMeasurements, speed });
    }
    if (testTime > opts.duration.max) {
      testComplete = true;
      speed = aggregate(snapshots);
    }
    const latency = loadedLatency(latencyMeasurements).value;
    if (testComplete) {
      finish({ speed, bytes: totalBytes, latency });
      return;
    }
    if (activeSnapshot) {
      progressMeasurements.push({ speed });
      onProgress({ speed, bytes: totalBytes, latency });
    }
    tickTimer = setTimeout(tick, PROGRESS_MS);

    const desired = rampTarget(speed, activeWorkersCount, opts.connections.max);
    for (let i = activeWorkersCount; i < desired; i++) startNewWorker();
  }

  test(1);
  return {
    promise,
    cancel() {
      if (finished) return;
      finished = true;
      stopAll();
      resolveRun(null);
    },
  };
}

// ============================================================================ the engine

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/**
 * Create a speed test. See README "Engine". Extra options, for tests and harnesses:
 * `WebSocket` and `WebTransport` (constructors), `now` (ms clock), `fetch` (for libcurl's files),
 * `libcurl` (an already loaded libcurl object), `speedPort` (overrides where.speedPort).
 */
export function createSpeedtest(options = {}) {
  const mode = options.mode;
  if (mode !== "gcore" && mode !== "netflix") throw new TypeError(`unknown mode: ${mode}`);
  if (!options.wispUrl) throw new TypeError("wispUrl is required");
  const transport = options.transport ?? "auto";
  if (!TRANSPORTS.includes(transport)) throw new TypeError(`unknown transport: ${transport}`);
  const where = options.where || {};
  const cmin = clampInt(options.connections?.min, 1, 30, 1);
  const cmax = Math.max(cmin, clampInt(options.connections?.max, 1, 30, 8));
  const dmin = Math.max(0, Number(options.duration?.min ?? 5) || 0);
  const dmax = Math.max(dmin, Number(options.duration?.max ?? 30) || 30);
  const opts = {
    mode,
    wispUrl: options.wispUrl,
    where,
    connections: { min: cmin, max: cmax },
    duration: { min: dmin, max: dmax },
    libcurlBase: options.libcurlBase || LIBCURL_BASE,
    speedPort: clampInt(options.speedPort ?? where.speedPort, 1, 65535, 80),
    transport,
    webtransport: webtransportConfig(options.webtransport, options.wispUrl),
  };
  const ctx = {
    opts,
    wispUrl: opts.wispUrl,
    WebSocket: options.WebSocket || globalThis.WebSocket,
    WebTransport: options.WebTransport || globalThis.WebTransport,
    now: options.now || (() => performance.now()),
    pool: null,   // the run's connections, made once the transport is chosen
    probe: null,  // the first WebTransport session while it opens
  };

  const listeners = new Map();
  let started = null;
  let stopped = false;
  let tester = null;
  const abort = new AbortController();

  function emit(name, data) {
    const set = listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb({ ...data });
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  }

  async function fetchNetflixTargets() {
    const libcurl = options.libcurl || (await loadLibcurl(opts.libcurlBase, { fetch: options.fetch }));
    libcurl.set_websocket(opts.wispUrl);
    // A session of its own, closed once the answer is read: libcurl's default pool would keep the
    // TLS connection to api.fast.com (a Wisp stream) open for the rest of the page's life.
    const session = libcurl.HTTPSession ? new libcurl.HTTPSession() : null;
    let json;
    try {
      const r = await (session || libcurl).fetch(API_FAST_COM, { signal: abort.signal });
      if (!r.ok) throw new Error(`api.fast.com: HTTP ${r.status}`);
      json = await r.json();
    } finally {
      if (session) session.close();
    }
    const targets = netflixTargets(json);
    if (!targets.length) throw new Error("api.fast.com returned no plain-HTTP test servers");
    return targets;
  }

  async function getTargets() {
    if (mode === "netflix") return { targets: await fetchNetflixTargets(), refresh: fetchNetflixTargets };
    if (!where.addr) throw new Error("where.addr is required in gcore mode");
    const addr = String(where.addr);
    const urlHost = addr.includes(":") ? `[${addr}]` : addr;
    const target = makeTarget(`http://${urlHost}:${opts.speedPort}/speedtest/range/`, {
      label: where.host || "wisp.baby",
      addr,
      connectHost: addr,
      hostHeader: "wisp.baby",
    });
    return { targets: [target], refresh: null };
  }

  /**
   * Choose the run's transport and make its pool (README "Engine", `transport`). WebTransport needs
   * the constructor and a listener (opts.webtransport); its first session is opened here, before
   * any load, and proves the path: if it does not open, `auto` runs the whole test over WebSocket
   * and says why in `fallback`, `webtransport` fails the run. The run never mixes the two.
   */
  async function chooseTransport() {
    const ws = (fallback = null) => {
      ctx.pool = new WispPool(opts.wispUrl, { WebSocket: ctx.WebSocket });
      return { transport: "websocket", url: opts.wispUrl, fallback };
    };
    const wt = opts.webtransport;
    const WT = typeof ctx.WebTransport === "function" ? ctx.WebTransport : null;
    if (transport === "websocket") return ws();
    if (!WT || !wt) {
      if (transport === "webtransport") {
        throw new Error(WT ? "the relay has no WebTransport listener" : "this browser has no WebTransport");
      }
      return ws();
    }
    const connect = () => new WtConnection(wt.url, { WebTransport: WT, hashes: wt.hashes });
    const first = connect();
    ctx.probe = first;
    try {
      await first.open(transport === "auto" ? WT_AUTO_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS);
    } catch (e) {
      first.close();
      if (stopped) return null;
      const why = (e && e.message) || String(e);
      if (transport === "webtransport") throw new Error(`WebTransport to ${wt.url}: ${why}`);
      return ws(why);
    } finally {
      ctx.probe = null;
    }
    if (stopped) {
      first.close();
      return null;
    }
    ctx.pool = new WispPool(wt.url, { connect });
    ctx.pool.adopt(first);
    return { transport: "webtransport", url: wt.url, fallback: null };
  }

  function phaseTest(type, getter, onProgress) {
    if (stopped) return Promise.resolve(null);
    tester = runTester(ctx, type, getter, onProgress);
    return tester.promise.finally(() => {
      tester = null;
    });
  }

  async function run() {
    let phase = "servers";
    try {
      emit("phase", { phase });
      const { targets, refresh } = await getTargets();
      if (stopped) return null;
      emit("servers", {
        wisp: { host: where.host, addr: where.addr, city: where.city, country: where.country },
        targets: targets.map((t) => ({ label: t.label, addr: t.addr })),
      });
      const getter = new UrlGetter(targets, refresh, ctx.now);
      const via = await chooseTransport();
      if (!via || stopped) return null;
      emit("transport", via);
      if (stopped) return null;
      // Every connection the run will use, opened now, before any load (WispPool says why). The
      // latency test's min(5, max) workers fit in it too.
      ctx.pool.warm(opts.connections.max);

      phase = "download";
      emit("phase", { phase });
      getter.reset();  // fast.com: download() resets the URL getter
      const down = await phaseTest("download", getter, (p) =>
        emit("download", { speedBps: p.speed ?? 0, bytes: p.bytes, loadedLatencyMs: p.latency, final: false }),
      );
      if (!down || stopped) return null;
      const download = { speedBps: down.speed ?? 0, bytes: down.bytes, loadedLatencyMs: down.latency };
      emit("download", { ...download, final: true });

      phase = "latency";
      emit("phase", { phase });
      const lat = await phaseTest("latency", getter, (p) =>
        emit("latency", { unloadedMs: p.value, count: p.count, final: false }),
      );
      if (!lat || stopped) return null;
      const latency = { unloadedMs: lat.value, count: lat.count };
      emit("latency", { ...latency, final: true });

      phase = "upload";
      emit("phase", { phase });
      const up = await phaseTest("upload", getter, (p) =>
        emit("upload", { speedBps: p.speed ?? 0, bytes: p.bytes, final: false }),
      );
      if (!up || stopped) return null;
      const upload = { speedBps: up.speed ?? 0, bytes: up.bytes };
      emit("upload", { ...upload, final: true });

      phase = "done";
      stopped = true;
      ctx.pool.close();
      emit("phase", { phase });
      return { download, latency, upload, transport: via };
    } catch (e) {
      if (stopped) return null;
      teardown();
      emit("error", { message: (e && e.message) || String(e), phase });
      return null;
    }
  }

  function teardown() {
    stopped = true;
    if (tester) tester.cancel();
    if (ctx.probe) ctx.probe.close();
    if (ctx.pool) ctx.pool.close();
    abort.abort();
  }

  const api = {
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return api;
    },
    off(name, cb) {
      listeners.get(name)?.delete(cb);
      return api;
    },
    /** Starts the run; resolves {download, latency, upload, transport} when done, null if stopped or failed. Never rejects. */
    start() {
      if (!started) started = stopped ? Promise.resolve(null) : run();
      return started;
    },
    /** Stops everything and closes every connection. No events follow. */
    stop() {
      if (stopped) return;
      teardown();
    },
    get running() {
      return !!started && !stopped;
    },
  };
  return api;
}
