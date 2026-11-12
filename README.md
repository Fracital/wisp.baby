# wisp.baby

wisp.baby is a fast.com-style speed test that runs **entirely over Wisp**, plus
the public Wisp relay itself. Each wisp box serves it through OpenResty, with
holyWisp on a loopback port behind it.

It is a small static page with no build step.

## Layout

| Path | What |
|---|---|
| `site/index.html` | The page: markup and styles. |
| `site/styles.css` | Styles (light and dark). |
| `site/app.js` | UI: big number, mode switch, more info, settings. ES module. |
| `site/speedtest.js` | Engine: Wisp v1 client, HTTP/1.1 over a Wisp stream, the fast.com algorithm. ES module, no dependencies. |
| `site/favicon.svg` | Icon. |
| `dev/serve.py` | Local harness: serves `site/`, `/where`, `/speedtest/range/*`, and points the page at a local holyWisp. |
| `dev/run-holywisp.sh` | Fetches holyWisp from npm (integrity checked) and runs it on `ws://127.0.0.1:6011/` with a dev config. |
| `test/` | `node --test 'test/*.test.mjs'`. The end-to-end test runs only with `HOLYWISP_BIN` set. |

Each box serves `site/` from `/var/www/wispbaby/`.

Locally:

```sh
dev/run-holywisp.sh        # ws://127.0.0.1:6011/
python3 dev/serve.py       # http://127.0.0.1:8080/ (+ :8081 speed test)
# open http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/
```

## Two modes (the switch on the page)

- **G-Core (self-hosted)**: the test servers are the wisp box itself. Each
  connection is a Wisp TCP stream from the browser to `<box address>:<speedPort>` (80, from `/where`), where
  OpenResty answers `/speedtest/range/A-B`. Only the box's own addresses may use
  that endpoint, so it is reachable through Wisp and nothing else. This measures
  you ⇄ Wisp ⇄ box.
- **Netflix (proxied)**: the test servers are Netflix Open Connect appliances,
  reached through Wisp. One HTTPS call to `api.fast.com` (through Wisp, TLS by
  libcurl.js) lists them. It runs with `https=false`, so the downloads are plain
  HTTP to literal OCA addresses and need no TLS in the browser. Netflix chooses
  the OCAs by the caller's address, which is the wisp box. This measures
  you ⇄ Wisp ⇄ box ⇄ Netflix.

## Contract

### Server (OpenResty on each box, all names `wisp.baby` and `*.wisp.baby`)

HTTPS (443):
- `GET /`: `site/index.html` (and the other `site/` files at `/<name>`).
- WebSocket upgrade on `/`: the Wisp relay (holyWisp on a loopback port). Public, no key, like holywisp.fracit.al. Wisp v1: the client sends no subprotocol.
- `GET /where`: `application/json`, `Cache-Control: no-store`:
  `{"site":"chi","host":"chi.wisp.baby","city":"Chicago","country":"US","addr":"<$server_addr, the address the browser reached>","speedPort":80}`
  (`speedPort` is 80 on the boxes; the dev harness uses another port.)
- `GET /health`: holyWisp's health.

HTTP (80), from the box's own addresses only (anything else: 403):
- `GET /speedtest/range/A-B`: `B-A+1` bytes of incompressible data, `Content-Length`, `Cache-Control: no-store`, keep-alive. `A-B` capped at 25 MiB (26214400 bytes).
- `POST /speedtest/range/A-B`: reads and discards the body (up to 26214400 bytes), answers `200` with an empty body.
- Everything else on :80 behaves as today (ACME, redirect to HTTPS).

The browser sends `Host: wisp.baby` on these.

### Engine (`site/speedtest.js`)

```js
import { createSpeedtest } from "./speedtest.js";
const t = createSpeedtest({
  mode: "gcore" | "netflix",
  wispUrl: "wss://wisp.baby/",
  where: { site, host, city, country, addr, speedPort },  // /where as served; speedPort defaults to 80
  connections: { min: 1, max: 8 },
  duration: { min: 5, max: 30 },     // seconds; the tester's bounds (UI settings)
  libcurlBase: "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.4/",  // netflix mode only, see below
});
t.on(event, cb); t.start(); t.stop();
```

Events (every payload is a plain object):
- `phase` `{ phase: "servers" | "download" | "latency" | "upload" | "done" }`
- `servers` `{ wisp: { host, addr, city, country }, targets: [{ label, addr }] }`
- `download` `{ speedBps, bytes, loadedLatencyMs, final }` (fired every progress tick, `final: true` once)
- `latency` `{ unloadedMs, count, final }`
- `upload` `{ speedBps, bytes, final }`
- `error` `{ message, phase }`

Order: servers, download (with loaded latency), unloaded latency, upload, done.

libcurl.js (netflix mode only, loaded lazily): `libcurl.js@0.7.4` from jsDelivr
(`https://cdn.jsdelivr.net/npm/libcurl.js@0.7.4/libcurl.mjs` and `libcurl.wasm`).
The engine fetches both files, checks their SHA-256 with WebCrypto, and loads them
from blob URLs (dynamic `import()` takes no SRI):
- `libcurl.mjs`: sha384 `HPoVcSWmDnDfiUF+cQungoKNOHcIxImN/etFDay9rQosy344svK4dmplcAC8nIRP` (base64)
- `libcurl.wasm`: sha256 `fe42bbcbd90b06c020ee4e0f11b86e8a671bfbb8fea3ee27200b116b7286dea9` (hex)

Both match the npm package `libcurl.js` 0.7.4. libcurl is used for the single
`api.fast.com` call and nothing else.

## The fast.com algorithm (recon 2026-11-12, fast.com app-0bffe1.js)

- **Server list**: `GET https://api.fast.com/netflix/speedtest/v2?https=false&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5`
  returns `{client:{ip,asn,location}, targets:[{name,url,location}]}`. Each URL becomes a range URL by replacing
  `speedtest` with `speedtest/range/`. URLs are signed (`t=`) and expire in about an hour. The `t=` token is tied to
  the scheme: an https URL fetched over http gives 403. With `https=false` the URLs are `http://<ip>/speedtest?...`
  and the locations say only "Open Connect, Netflix". OCAs send `Access-Control-Allow-Origin: *` and do not check `Origin`.
  POST to a range URL is accepted (upload).
- **Workers**: a worker owns one target (round-robin over the targets) and has two requesters: data and pinger.
  Data requests are `range/0-<size>` with size = 26214400 minus the number of requests already made to that OCA
  (so no two are identical). On completion the worker immediately sends the next request.
- **Ramp**: start `connections.min` workers. Every progress tick (150 ms), if fewer than `connections.max` are active:
  speed > 50 Mb/s → max; else > 10 Mb/s and active < 5 → 5; else > 1 Mb/s and active < 3 → 3; then, separately,
  > 0.5 Mb/s and active < 2 → 3. Start the difference.
- **Snapshots**: each tick, the bytes received since the last snapshot and the time they took (a tick with no new
  bytes makes no snapshot; its time folds into the next).
- **Speed (stableMovingAverage(5), reset threshold 5)**: while there are fewer than 5 snapshots, reset state each tick.
  Otherwise, until the start is fixed: sum the last 5 snapshots; if that window's rate ≥ the best so far, adopt it
  (best = it, bytes/time = its sums, start = end of array); else fix the start. Then add every snapshot after `start`
  to bytes/time, set `start` to the array length, and return `8000 * bytes / time` b/s (time in ms).
- **Stop (stableDeltaMeasurementsStopper)**: minDuration 7 s, maxDuration 30 s, stabilityDelta 2 %, minStable 6.
  Complete when testTime ≥ max; or when ≥ 6 measurements, the max of the last 3 is at least 3 back from the end,
  every one of the last 6 is within 2 % of the current speed, and testTime ≥ 7 s. The tester only asks the stopper
  once testTime > `duration.min`, and forces completion past `duration.max`. testTime counts from the first worker's start.
- **Latency**: a pinger sends `range/0-0` and times request to response. During download/upload each worker pings
  about once a second (`1000 - lastLatency` ms between). Loaded latency = min over workers with > 4 samples of their
  75th percentile (all workers if none has > 4). The unloaded test runs `min(5, connections.max)` workers pinging back
  to back and completes once it has run > 5 s with > 50 samples; unloaded = min over workers of their 10th percentile.
- **Percentile**: sort, index = (n-1)·p, linear interpolation between floor and floor+1.
- **Retries**: a failed request on a target marks it bad and restarts the attempt (up to 10 attempts); the URL getter
  skips an OCA after 2 failures and a site after 3.
- **Display**: < 1 Mb/s → Kbps; ≥ 995 Mb/s → Gbps; < 9.95 → one decimal; < 100 → integer; else rounded to 10.
  MB: < 1 → two decimals, < 10 → one decimal, else rounded to 10.

Over Wisp each worker uses **its own WebSocket** (so the browser ⇄ box leg has as many TCP flows as fast.com has to
its OCAs), with the data stream and the pinger as two Wisp streams on it. The run opens its `connections.max`
sockets once, before the download, and a worker leases one exclusively and hands it back when it stops, so later
phases reuse them: Chrome holds a new WebSocket handshake to the same endpoint for 5 to 15 s while other sockets to
it are saturated with uploads, which left ramp workers idle and restarted the test on the 10 s handshake timeout.
Upload progress counts bytes that have left the WebSocket: bytes handed to `ws.send` minus `ws.bufferedAmount`,
sending only while the stream's Wisp CONTINUE window allows and `bufferedAmount` is under a few MiB.
