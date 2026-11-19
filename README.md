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
| `site/speedtest.js` | Engine: Wisp v1 client over WebTransport or WebSocket, HTTP/1.1 over a Wisp stream, the fast.com algorithm. ES module, no dependencies. |
| `site/livestats.js` | Live stats maths: formatting, the graph's series window and stacked-area geometry. No DOM; `app.js` draws. |
| `site/favicon.svg` | Icon. |
| `dev/serve.py` | Local harness: serves `site/`, `/where`, made-up `/live`, `/live/history` and `/you`, `/speedtest/range/*`, and points the page at a local holyWisp. |
| `dev/run-holywisp.sh` | Fetches holyWisp from npm (integrity checked) and runs it on `ws://127.0.0.1:6011/` with a dev config; `HOLYWISP_BIN=<local build>` runs that instead, with its WebTransport listener on. |
| `test/` | `node --test 'test/*.test.mjs'`. The end-to-end tests run only with `HOLYWISP_BIN` set: `e2e.test.mjs` drives the engine in Node (WebSocket), `browser.test.mjs` the page in headless Chrome (WebTransport with no WebSocket at all, WebSocket, the fallback after two sessions; with `E2E_NETFLIX=1` also Netflix mode over WebTransport). |

Each box serves `site/` from `/var/www/wispbaby/`.

Locally:

```sh
dev/run-holywisp.sh        # ws://127.0.0.1:6011/
python3 dev/serve.py       # http://127.0.0.1:8080/ (+ :8081 speed test)
# open http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/
```

The npm build `run-holywisp.sh` fetches has no WebTransport, so the page runs over WebSocket. To run
it over WebTransport locally, use a holyWisp build that has it:
`HOLYWISP_BIN=~/src/holyWisp/build/release/holywisp dev/run-holywisp.sh`. The page then finds
`http://127.0.0.1:6011/webtransport.json` (from the `?wisp=` relay's origin) and pins the listener's
self-signed certificate by the hashes in it. `&transport=ws` or `&transport=wt` forces one.

Headless Chrome, the whole page against a local holyWisp (needs a build with WebTransport):

```sh
HOLYWISP_BIN=~/src/holyWisp/build/release/holywisp node --test test/browser.test.mjs
```

`dev/serve.py --no-live` answers the stats with 503, like a box whose stats are down;
`--no-domains` leaves the by-domain fields out, like a v1 collector.

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
- `GET /webtransport.json`: holyWisp's own answer, passed through, `Cache-Control: no-store`:
  `{"url":"https://holywisp.fracit.al/","hashes":[]}`. `url` is the box's WebTransport listener (holyWisp
  on udp 443, Wisp over HTTP/3), `""` meaning the relay's own host and port; `hashes`
  (`[{"algorithm":"sha-256","value":"<base64>"}]`) are listed only for a self-signed certificate and the
  page then passes them as `serverCertificateHashes`. On the boxes the listener has a Let's Encrypt
  certificate for holywisp.fracit.al, so the list is empty and the browser checks it like any https
  site. Absent (404, not JSON, no `url`): the page runs over WebSocket.
- The page's `Content-Security-Policy` allows the WebTransport URL's origin in `connect-src`
  (WebTransport is a fetch to the browser: `https://holywisp.fracit.al`), beside `'self'` and the
  `wss://` relay names.
- `GET /where`: `application/json`, `Cache-Control: no-store`:
  `{"site":"chi","host":"chi.wisp.baby","city":"Chicago","country":"US","addr":"<$server_addr, the address the browser reached>","speedPort":80}`
  (`speedPort` is 80 on the boxes; the dev harness uses another port.)
- `GET /health`: holyWisp's health.
- `GET /live`, `GET /live/history`, `GET /you`: live usage stats, see "Live stats" below.

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
  transport: "auto" | "webtransport" | "websocket",  // default "auto"
  webtransport: { url, hashes },     // /webtransport.json as served, or null/absent: no listener
});
t.on(event, cb); t.start(); t.stop();
```

`start()` resolves `{ download, latency, upload, transport }` (the payloads of the final events
and of `transport`), or `null` if the run was stopped or failed.

Transport (decided once per run, before the download, and never mixed within a run):
- `websocket`: `wispUrl`.
- `webtransport`: a session to `webtransport.url`; the run fails (`error`, phase `servers`) if the
  browser has no `WebTransport`, there is no listener, or the first session does not open in 10 s.
- `auto`: WebTransport when the browser has `WebTransport` and `webtransport` names a listener,
  else WebSocket. The first session is opened before anything else; if it fails or has not
  delivered its stream-0 CONTINUE within 3 s, a second, fresh session gets another 3 s (starting
  at least 0.5 s after the first gave up), and only if that one fails too does the whole run go
  over WebSocket, with the `transport` event saying why. Every run tries again from the start:
  nothing about a failure is remembered.

Netflix mode's one `api.fast.com` call (libcurl.js) uses the run's transport, like its downloads
and uploads. Over WebTransport, libcurl gets a custom transport (`libcurlTransport`): every TCP
connection it makes is a Wisp stream on one of the run's sessions (an idle one, else one a worker
holds; never a new one, so a mid-run refresh of the list opens nothing), and the run creates no
WebSocket at all. Over WebSocket, libcurl opens its own Wisp WebSocket to `wispUrl`.

Events (every payload is a plain object):
- `phase` `{ phase: "servers" | "download" | "latency" | "upload" | "done" }`
- `servers` `{ wisp: { host, addr, city, country }, targets: [{ label, addr }] }`
- `transport` `{ transport: "webtransport" | "websocket", url, fallback }` (once, after `servers`,
  before the download; `fallback` is why WebTransport did not open when `auto` fell back, else null)
- `download` `{ speedBps, bytes, loadedLatencyMs, final }` (fired every progress tick, `final: true` once)
- `latency` `{ unloadedMs, count, final }`
- `upload` `{ speedBps, bytes, final }`
- `error` `{ message, phase }`

Order: servers, transport, download (with loaded latency), unloaded latency, upload, done.

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

Over Wisp each worker uses **its own connection**, a WebTransport session or a WebSocket (so the browser ⇄ box leg
has as many congestion-controlled flows as fast.com has TCP connections to its OCAs: separate QUIC connections over
WebTransport, separate TCP connections over WebSocket), with the data stream and the pinger as two Wisp streams on it.
The run opens its `connections.max` connections once, before the download, and a worker leases one exclusively and
hands it back when it stops, so later phases reuse them: Chrome holds a new WebSocket handshake to the same endpoint
for 5 to 15 s while other sockets to it are saturated with uploads, which left ramp workers idle and restarted the
test on the 10 s handshake timeout.

Wisp over WebTransport (holyWisp `docs/webtransport.md`, "Wisp on the session"): the page opens the session with no
`protocols` (that selects Wisp v1, as no subprotocol does on a WebSocket) and one bidirectional stream, the Wisp
stream, which carries Wisp packets back to back, each preceded by its length as a u32 LE. The packets are exactly
those a WebSocket message carries, and the server opens with the same stream-0 CONTINUE; the CONTINUE window is
honoured the same way. Datagrams carry only UDP stream DATA, which the speed test never opens.

Upload progress counts bytes that have left the connection, sending only while the stream's Wisp CONTINUE window
allows and the connection's `bufferedAmount` is under a few MiB:
- WebSocket: bytes handed to `ws.send` minus `ws.bufferedAmount`.
- WebTransport: bytes written to the Wisp stream minus those whose `writer.write()` has not resolved. A write
  resolves when the browser has moved the bytes out of the stream's queue into its network stack (Chrome: into the
  data pipe to its network service, the hand-off at which a WebSocket's `bufferedAmount` stops counting them too),
  so it is the same measure. The page counts its own unresolved writes rather than reading `writer.desiredSize`,
  whose high-water mark is the browser's and may count chunks rather than bytes.

## Live stats

Under the speed test the page shows what the relay is doing: a live graph of throughput by box or
by domain, totals for all of them, and the visitor's own numbers. The page polls `/live` every 2 s (paused
while the tab is hidden, backing off to 30 s while it fails), `/you` every 15 s and right after a
test, and `/live/history` when a long view is open.

How the numbers get there (all in abulxt; nothing here talks to anything but the box it was loaded
from):

1. Every 2 s each box's OpenResty reads its holyWisp's loopback `/stats` (bytes), adds its own
   counters (relay sessions, open sessions, speed test bytes) and writes them to a Redis hash on
   abulxt's origin. In the same round trip it reads back the two blobs below.
2. A collector on the origin turns the five boxes' counters into rates and totals, keeps the last
   10 minutes in memory and per-minute and per-hour rows in Postgres, and writes the blobs.
3. Each box serves the blobs from its own shared memory, so a page poll never reaches Redis or
   Postgres.

Sessions are WebSocket upgrades on the relay (wisp.baby, abulxt's byod and Fracital's relay names,
all on the same holyWisp). Bytes are holyWisp's, so they include the speed tests, which are also
counted on their own. A WebTransport session (the speed test's default) reaches holyWisp on udp 443
without passing OpenResty, so it is not counted as a session and its bytes land in "other" by domain;
the speed test's own byte counter (the `/speedtest/range/` endpoint) counts it either way.

By domain: every relay route tags its sessions with the organization whose domain they came in on:
Abstract (abulxt's byod names), Fracital (Fracital's names and holywisp.fracit.al), STomp
(stomp.fracit.al), wisp.baby for wisp.baby's own relay and speed test, and "other" for the rest. STomp
only counts as STomp because its relay URL is on its own name: `STOMP_WISP_URL=wss://stomp.fracit.al/pipe/<Fracital
gate key>/` in terp's `/opt/stomp/repo/.env` (since 2026-11-14; on `wss://holywisp.fracit.al/` it counted as
Fracital). "other" also takes bytes that arrive while no tagged session is open, such as those of sockets opened
before an OpenResty reload. Sessions per domain are exact. Bytes per domain are an
estimate, because holyWisp only counts bytes box-wide and a WebSocket's own byte count is only known
when it closes. So each box splits every 2 s of its traffic across the domains by their open
sessions, weighted by the bytes per second of each domain's recently finished sessions. The domains
always add up to the box. The labels come from the collector's config. Changing them never changes
the history, which is stored by tag.

Privacy: the stats are counters. Distinct clients are a HyperLogLog of a salted HMAC of the client
address (the same salt on every box, kept secret), kept 35 days. A visitor's own numbers are kept
on the box they used, under that HMAC, in hourly buckets that expire after 25 hours. No address is
written to Redis, Postgres or a log by any of this.

`GET /live` (`application/json`, `Cache-Control: public, max-age=1`; 503 `{"v":1,"stale":true}`
before the box has had any):

```json
{
  "served": 1763000001500, "stale": false,
  "v": 1, "ts": 1763000000000,
  "now": { "downBps": 0, "upBps": 0, "sessionsActive": 0, "streamsActive": 0 },
  "peak24h": { "bps": 0, "at": 1763000000000 },
  "totals": { "h5": { "bytes": 0, "sessions": 0 }, "d7": { "bytes": 0, "sessions": 0 },
              "d30": { "bytes": 0, "sessions": 0 }, "all": { "bytes": 0, "sessions": 0, "since": 1763000000000 } },
  "speedtest": { "h5": 0, "d7": 0, "d30": 0, "all": 0 },
  "clients": { "today": 0, "d30": 0, "ipDays30": 0 },
  "byodDomains": 0,
  "sites": [ { "site": "mia", "city": "Miami", "country": "US", "up": true, "downBps": 0, "upBps": 0, "sessionsActive": 0 } ],
  "tail": { "step": 2000, "t0": 1763000000000, "sites": { "mia": [0] } }
}
```

- Rates are bits per second, sizes bytes, times ms since the epoch. "down" is toward the client.
- `served` is the box's clock when it answered; `stale` is true when the box has not had a fresh
  blob for more than 10 s (the origin or its Redis is unreachable); `served - ts` is the age.
- `sites` is in a fixed order; the page colours each box by its place in it.
- `tail` is the last 30 samples, 2 s apart, of each box's total (down + up); `t0` is the first.
- `clients.today` is distinct clients this UTC day, `d30` over the last 30 days, `ipDays30` the
  sum of the daily counts. `byodDomains` counts certificates for names that are not ours.
- By domain (v1 collectors leave these out; the page then shows only the by-box view):
  `"domains": [ { "key": "wispbaby", "label": "wisp.baby", "downBps", "upBps", "sessionsActive" } ]`
  in a fixed order, `"other"` last; `"domainTotals": { "<key>": { "h5", "d7", "d30", "all" } }`
  (each `{ "bytes", "sessions" }`); and `tail.domains`, built like `tail.sites`. The page colours
  the first five domains like the boxes, folds any more into "other", and draws "other" grey.

`GET /live/history` (`max-age=30`): `{ "v": 1, "ts", "m10", "h24", "d7", "domainLabels" }`, each
block `{ "step", "t0", "sites": { "<site>": [bps, …] }, "domains": { "<key>": [bps, …] } }`:
300 × 2 s samples, 288 × 5 min averages and 168 × 1 h averages, oldest first. `domainLabels` is
`[ { "key", "label" } ]` in the `/live` `domains` order.

`GET /you` (`no-store`):
`{ "v": 1, "ip", "city", "country", "site", "rttMs", "openSessions", "day": { "bytes", "sessions" } }`.
`city` and `country` come from DB-IP City Lite (CC BY 4.0, credited on the page) and are `null`
when unknown. `rttMs` is the kernel's smoothed TCP RTT for the visitor's connection to the box.
`day` is the last 24 hours on this box, counted as each session closes.

## License

ISC. See `LICENSE`.
