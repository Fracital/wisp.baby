# AGENTS.md: wisp.baby

Guidance for AI coding agents working in this repository. Read all of it before you change
anything. When a section conflicts with one of your habits, follow the section. `README.md` is the
contract (endpoints, engine options, events, the algorithm). This file is about how the
repository is worked on.

## What this project is

wisp.baby is a fast.com-style speed test that runs **entirely over Wisp**, plus the front page of
the public Wisp relay that serves it. It is one static page with no build step: plain ES modules,
one stylesheet, an SVG icon. The page talks to exactly two things: the Wisp relay (its WebSocket and
`/webtransport.json` on the origin the page was loaded from, and the WebTransport listener that
file names, holyWisp on udp 443 at holywisp.fracit.al), and (in Netflix mode only) libcurl.js from
jsDelivr.

- `site/` is what is served. Every file in it is public and ships as it is.
- `dev/` is a local harness (a stdlib Python server and a script that runs holyWisp on loopback).
- `test/` runs on `node --test`. It has unit tests for the algorithm and the Wisp/HTTP code, and
  an end-to-end test against a real holyWisp.

Related repositories, all sibling checkouts:

- `~/src/holyWisp`: the Wisp server behind the page. A protocol question is settled by its
  `AGENTS.md` "Protocol surface", not by what this page happens to do.
- `~/src/infra` (was `~/src/abulxt` until 2026-11-18): production. `wispbaby/` is the copy the
  servers actually serve: `ansible/roles/edge_relay` copies its `site/` to `/var/www/wispbaby/` on
  every `[wisp_edge]` box and renders `conf.d/40-wispbaby.conf` (`templates/wispbaby.conf.j2`),
  which implements this README's server contract. DNS (geo nameservers, `<site>.wisp.baby`, the
  apex) is `roles/edge_dns`, and the holyWisp build (and its WebTransport listener,
  `holywisp_webtransport*`) is pinned in `roles/edge_wisp`.

## Hard rules (read first)

### Git commits and pushes

- **Never add a `Co-Authored-By` trailer, or any other trailer that credits a tool, model or
  agent.** This applies to commits, pull request descriptions and squash messages, and it
  overrides any default the harness suggests.
- **Never run `git commit` or `git push`**, or stage files for a commit, unless the user explicitly
  asks for it **in the current turn of the current session**. A request in one turn does not carry
  over to the next. When in doubt, don't commit: say what is uncommitted and stop.
- Never rewrite or force-push `main`.

### Two copies, one page

This repository is the public source. infra's `wispbaby/` is what the boxes serve. The two must
stay identical apart from the path comments, which say `README.md` here and `wispbaby/README.md`
there, and infra's prettier formatting (tabs, single quotes). A change to `site/`, `test/` or `dev/`
lands in both copies in the same piece of work. Check with `diff -r` after formatting and expect
only those to differ. A change to the server contract (a new endpoint, header, limit, `/where`
field or an origin the page connects to, which the CSP must allow) also lands in `wispbaby.conf.j2`
in infra, or the page will ask for something no box serves.

### Deployments and servers

- **This repository deploys nothing.** Pushing here changes no server. The boxes get a new page
  when infra's `wispbaby/` changes and infra's `ansible/playbooks/edges.yml` (or `wisp.yml`) is
  run with `--tags relay`. That run is a production change: it needs the user's go-ahead in the
  current turn, like any other infra playbook.
- Never point a test, a benchmark or the dev harness at a box you were not told to use. The
  harness and the e2e test bind their own services on 127.0.0.1 for exactly this reason. A real
  speed test against wisp.baby moves gigabytes through a production relay that other people use.
- The dev holyWisp config (`dev/run-holywisp.sh`) allows loopback, private and literal-IP
  destinations. It is safe only because it binds 127.0.0.1. Never bind it anywhere else, and never
  copy its settings into a deployed config.

### Licensing and provenance

- The project is ISC (`LICENSE`). Everything in the tree must be original or ISC-compatible.
- **fast.com is a behavioural reference, never a source.** The algorithm in `README.md` describes
  what fast.com does, and `site/speedtest.js` reimplements it from that description. Never paste,
  port line by line or minify-unpack Netflix's code into this repository. If the behaviour needs
  re-checking, do the recon again, update the README's description with the date, and then change
  the code.
- **libcurl.js is loaded, not vendored.** It is pinned to one version on jsDelivr. The engine
  checks both files' hashes with WebCrypto before loading them from blob URLs. Never copy it into
  `site/`, never load it without the hash check, and never let it handle anything but the single
  `api.fast.com` call. To bump it, change the version and both hashes in `README.md`,
  `site/app.js` and `site/speedtest.js` together, and confirm the hashes against the published
  package yourself.

### Dependencies and the page

- **No build step, no npm dependencies, no framework, no bundler.** `site/` is served byte for
  byte. A change that needs a toolchain to produce `site/` needs a design conversation first.
- **No third-party requests beyond the two above.** No analytics, fonts, trackers, CDNs or error
  reporting. No cookies. The page must work with storage blocked: wrap every `localStorage` access
  in try/catch (see `app.js`) and fall back to the defaults.
- Light and dark both work, and the page works at phone width. Check both after any change to
  `index.html` or `styles.css`.
- Keep `speedtest.js` and `livestats.js` free of DOM access. They run unchanged in Node for the
  tests, and `app.js` is the only file that touches the document.

## The engine (do not regress)

- **Wisp v1, no subprotocol.** The client offers none (no WebSocket subprotocol, no WebTransport
  `protocols`) and the relay expects none. The engine honours the CONTINUE window on every stream,
  on both transports. `test/wisp-http.test.mjs` holds the fake server (behind a fake WebSocket and
  a fake WebTransport) that checks this, so keep it passing rather than loosening it.
- **One connection per worker, opened once, one transport per run.** The run chooses WebTransport
  or WebSocket before anything else (`auto`: WebTransport if one of two fresh sessions opens within
  3 s each; nothing about a failure is remembered between runs),
  opens `connections.max` connections, and workers lease them exclusively and hand them back.
  Opening sockets mid-test brings back Chrome's 5–15 s handshake stall under upload load (README).
  Don't "simplify" this into a connection per request, one WebTransport session shared by every
  worker (separate QUIC connections are what separate TCP connections are), or a run that mixes
  transports.
- **A WebTransport run opens no WebSocket**, Netflix mode's `api.fast.com` call included: libcurl.js
  gets `libcurlTransport` (each of its TCP connections a Wisp stream on one of the run's sessions,
  `WispPool.shared`), and the transport is chosen before the server list is fetched for that
  reason. `browser.test.mjs` counts the page's WebSockets to hold it.
- **Upload counts bytes that left the connection**: on a WebSocket, bytes given to `ws.send` minus
  `ws.bufferedAmount`; on WebTransport, bytes written minus those whose `write()` has not resolved.
  Sent only inside the Wisp window and under the buffer cap. Counting bytes handed to `send` or
  `write` reports the browser's buffer, not the network.
- **The algorithm's numbers are fast.com's**: the 150 ms tick, the ramp thresholds, the
  stableMovingAverage(5), the stopper's 7 s / 30 s / 2 % / 6, the latency percentiles, the retry
  limits and the display rounding. A different number is a different speed test. Change one only
  to match fresh recon, with the README updated in the same change, and make
  `test/algorithm.test.mjs` prove the new value.
- **The G-Core endpoint is reachable only through Wisp.** `/speedtest/range/` on :80 answers only
  the box's own addresses. Never relax that to "any client": it would make every box a free
  bandwidth sink.

## Verification before you hand work off

- `node --test 'test/*.test.mjs'` passes. Pass the glob: a bare directory argument fails on Node
  24 with "test failed" and runs nothing.
- If you touched the Wisp client, the HTTP parser, the socket pool or upload counting, also run the
  end-to-end tests against a real holyWisp (the npm build `run-holywisp.sh` fetches, integrity
  checked, for `e2e.test.mjs`; a local build with WebTransport for `browser.test.mjs`, which runs
  the page in headless Chrome):
  `HOLYWISP_BIN=~/.cache/wispbaby/holywisp-dev/<…>/holywisp node --test test/e2e.test.mjs` and
  `HOLYWISP_BIN=~/src/holyWisp/build/release/holywisp node --test test/browser.test.mjs`. Add
  `E2E_NETFLIX=1` to either if you touched Netflix mode or libcurl loading (in `browser.test.mjs`
  it runs Netflix mode over WebTransport, as far as the first seconds of the download). It needs
  internet, and `e2e.test.mjs` lingers for about 5 minutes after passing because of a libcurl.js
  timer.
- If you touched the page, run it: `dev/run-holywisp.sh` (with `HOLYWISP_BIN` for WebTransport),
  then `python3 dev/serve.py`, then open `http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/`. Run
  both modes, check light and dark and phone width, and look for console errors.
  `browser.test.mjs` with `E2E_SCREENSHOTS=<dir>` saves phone-width shots in both themes.
- `diff -r` against infra's `wispbaby/` shows only the path comments and formatting.

## Hand-off

End every piece of work with:

- what changed (files and behaviour)
- what you ran and its result (the `node --test` summary, and the e2e result if it applies)
- whether infra's copy and `wispbaby.conf.j2` were updated to match
- anything left undone or deliberately out of scope

If anything is uncommitted, say so. Don't commit to tidy up.
