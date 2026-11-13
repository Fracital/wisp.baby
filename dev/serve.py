#!/usr/bin/env python3
"""
wisp.baby local dev harness (README.md). Python 3 stdlib only.

    python3 dev/serve.py
    dev/run-holywisp.sh        # in another terminal: ws://127.0.0.1:6011/
    open http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/

http://127.0.0.1:8080  the page (site/), GET /where (dev JSON), the same
                       security headers as the boxes, with a CSP that also lets the page reach
                       ws://127.0.0.1:* (the dev holyWisp). GET /live, /live/history and /you
                       answer with made-up but moving numbers for five fake boxes (README.md
                       "Live stats"); the dev speed test's own bytes show up in them.
                       --no-live makes them 503, like a box whose stats are down;
                       --no-domains leaves out the by-domain fields, like a v1 collector.
http://127.0.0.1:8081  the speed test endpoint the boxes serve on :80 (README.md
                       "Server"): GET /speedtest/range/A-B sends B-A+1 random bytes (at most
                       26214400), POST reads and drops the body (Content-Length required) and
                       answers an empty 200. Keep-alive, one thread per connection. The page
                       reaches it through the dev holyWisp, as a Wisp TCP stream to
                       127.0.0.1:8081 (speedPort in /where).

Both listen on 127.0.0.1 only. --port and --speed-port override the defaults.
"""
import argparse
import json
import math
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

CAP = 26214400
CHUNK = 1 << 20
RANGE = re.compile(r"^/speedtest/range/(\d{1,9})-(\d{1,9})$")
BUF = os.urandom(CHUNK)  # incompressible; one buffer for every response

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, "..", "site"))

CSP = ("default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self'; "
       "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://wisp.baby wss://*.wisp.baby "
       "https://cdn.jsdelivr.net blob:; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; "
       "form-action 'none'; frame-ancestors 'none'")


class FakeStats:
    """Moving, made-up numbers in the shape of /live, /live/history and /you (README.md
    "Live stats"). A smooth daily curve per box plus wobble, as a pure function of time, so the
    tail and the history agree; the dev speed test's real bytes are added on top (box 0)."""

    SITES = [("iev", "Kyiv", "UA", 0.9e9), ("mia", "Miami", "US", 2.6e9), ("jnb", "Johannesburg", "ZA", 0.5e9),
             ("ams", "Amsterdam", "NL", 1.8e9), ("mnz", "Manassas", "US", 3.1e9)]
    # The domain tags and the neutral labels the collector uses by default, with each one's share of
    # the traffic (they add up to 1). The dev speed test's bytes go to wisp.baby.
    DOMAINS = [("wispbaby", "wisp.baby", 0.08), ("abstract", "Abstract", 0.48), ("fracital", "Fracital", 0.36),
               ("stomp", "STomp", 0.06), ("other", "Other", 0.02)]
    STEP = 2000
    enabled = True
    domains_on = True

    def __init__(self):
        self.start = time.time()
        self.test_bytes = 0          # bytes the dev speed test moved (SpeedHandler adds)
        self.test_marks = []         # (t_ms, cumulative bytes), for the box-0 rate
        self.sessions = 0

    def add_test_bytes(self, n):
        self.test_bytes += n

    def mark(self):
        now = int(time.time() * 1000)
        if not self.test_marks or now - self.test_marks[-1][0] >= self.STEP // 2:
            self.test_marks.append((now, self.test_bytes))
            self.test_marks = self.test_marks[-400:]

    def test_bps(self, t):
        # Rate of the dev speed test around time t (ms), from the marks.
        prev = None
        for m in self.test_marks:
            if m[0] > t:
                break
            prev = m
        nxt = next((m for m in self.test_marks if m[0] >= t + self.STEP), None)
        if not prev or not nxt or nxt[0] == prev[0]:
            return 0
        return (nxt[1] - prev[1]) * 8000 / (nxt[0] - prev[0])

    def base_rate(self, i, t):
        base = self.SITES[i][3]
        hours = t / 3.6e6
        day = 0.55 + 0.45 * math.sin(2 * math.pi * (hours / 24 + i * 0.17))
        wob = 1 + 0.12 * math.sin(t / 37000 + i) + 0.07 * math.sin(t / 9100 + 2 * i)
        return max(0.0, base * day * wob)

    def rate(self, i, t):
        v = self.base_rate(i, t)
        if i == 0:
            v += self.test_bps(t)
        return int(v)

    def domain_rate(self, k, t):
        # The whole fleet's traffic times the domain's share, the shares drifting a little.
        key, _label, share = self.DOMAINS[k]
        drift = 1 + 0.25 * math.sin(t / 61000 + 3 * k)
        v = sum(self.base_rate(i, t) for i in range(len(self.SITES))) * share * drift
        if key == "wispbaby":
            v += self.test_bps(t)
        return int(v)

    def series(self, step, points, end):
        end = end - end % step
        t0 = end - (points - 1) * step
        def sample(fn):
            if step == self.STEP:
                return [fn(t0 + k * step) for k in range(points)]
            # an average over the bucket, from four samples
            return [int(sum(fn(t0 + k * step + j * step / 4) for j in range(4)) / 4) for k in range(points)]
        sites = {name: sample(lambda t, i=i: self.rate(i, t)) for i, (name, *_rest) in enumerate(self.SITES)}
        domains = {key: sample(lambda t, k=k: self.domain_rate(k, t)) for k, (key, *_rest) in enumerate(self.DOMAINS)}
        return {"step": step, "t0": t0, "sites": sites, "domains": domains}

    def domain_labels(self):
        return [{"key": key, "label": label} for key, label, _ in self.DOMAINS]

    def live(self):
        self.mark()
        now = int(time.time() * 1000)
        tail = self.series(self.STEP, 30, now)
        last = {name: tail["sites"][name][-1] for name, *_ in self.SITES}
        total = sum(last.values())
        sites = [{"site": n, "city": c, "country": cc, "up": True, "downBps": int(last[n] * 0.93),
                  "upBps": int(last[n] * 0.07), "sessionsActive": int(last[n] / 4.2e6)}
                 for n, c, cc, _ in self.SITES]
        lastd = {key: tail["domains"][key][-1] for key, *_ in self.DOMAINS}
        sess = int(total / 4.2e6)
        domains = [{"key": key, "label": label, "downBps": int(lastd[key] * 0.93), "upBps": int(lastd[key] * 0.07),
                    "sessionsActive": int(sess * share)} for key, label, share in self.DOMAINS]
        alltime = 519e12 + self.test_bytes
        dom_totals = {key: {"h5": {"bytes": int(4.1e12 * share), "sessions": int(15611 * share)},
                            "d7": {"bytes": int(130e12 * share), "sessions": int(495372 * share)},
                            "d30": {"bytes": int(512e12 * share), "sessions": int(1688441 * share)},
                            "all": {"bytes": int(alltime * share), "sessions": int(1701045 * share)}}
                      for key, _label, share in self.DOMAINS}
        gb = 1e9
        return self.v1({
            "served": now, "stale": False, "v": 1, "ts": tail["t0"] + 29 * self.STEP,
            "now": {"downBps": int(total * 0.93), "upBps": int(total * 0.07),
                    "sessionsActive": int(total / 4.2e6), "streamsActive": int(total / 0.9e6)},
            "peak24h": {"bps": int(total * 1.31), "at": now - 5 * 3600 * 1000},
            "totals": {"h5": {"bytes": int(4.1e12), "sessions": 15611},
                       "d7": {"bytes": int(130e12), "sessions": 495372},
                       "d30": {"bytes": int(512e12), "sessions": 1688441},
                       "all": {"bytes": int(519e12 + self.test_bytes), "sessions": 1701045,
                               "since": now - 31 * 86400 * 1000}},
            "speedtest": {"h5": int(18 * gb + self.test_bytes), "d7": int(410 * gb), "d30": int(1.6e12),
                          "all": int(1.7e12)},
            "clients": {"today": 3121, "d30": 47672, "ipDays30": 61204},
            "byodDomains": 37,
            "sites": sites,
            "domains": domains,
            "domainTotals": dom_totals,
            "tail": tail,
        })

    def v1(self, d):
        # --no-domains: what a v1 collector sends.
        if not self.domains_on:
            for k in ("domains", "domainTotals", "domainLabels"):
                d.pop(k, None)
            for block in d.values():
                if isinstance(block, dict):
                    block.pop("domains", None)
        return d

    def history(self):
        now = int(time.time() * 1000)
        return self.v1({"v": 1, "ts": now, "m10": self.series(self.STEP, 300, now),
                        "h24": self.series(300000, 288, now), "d7": self.series(3600000, 168, now),
                        "domainLabels": self.domain_labels()})

    def you(self, addr):
        return {"v": 1, "ip": addr, "city": "Localhost", "country": "--", "site": "mnz", "rttMs": 0.1,
                "openSessions": 0, "day": {"bytes": self.test_bytes, "sessions": self.sessions}}


STATS = FakeStats()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class SiteHandler(SimpleHTTPRequestHandler):
    server_version = "wispbaby-dev"
    protocol_version = "HTTP/1.1"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                      ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm",
                      ".webmanifest": "application/manifest+json"}
    where = {}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE, **kw)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Content-Security-Policy", CSP)
        path = self.path.split("?", 1)[0]
        if path not in ("/where", "/live", "/live/history", "/you"):
            self.send_header("Cache-Control", "no-cache")  # dev: always revalidate
        super().end_headers()

    def _json(self, status, obj, cache="no-store"):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/where":
            self._json(200, self.where)
            return
        if path in ("/live", "/live/history", "/you"):
            if not FakeStats.enabled:
                self._json(503, {"v": 1, "stale": True})
            elif path == "/live":
                self._json(200, STATS.live(), "public, max-age=1")
            elif path == "/live/history":
                self._json(200, STATS.history(), "public, max-age=30")
            else:
                self._json(200, STATS.you(self.client_address[0]))
            return
        # Same surface as the boxes: no dotfiles, no directory listings.
        if any(part.startswith(".") for part in path.split("/")) or (path.endswith("/") and path != "/"):
            self.send_error(404)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):
        sys.stderr.write("site  %s %s\n" % (self.address_string(), fmt % args))


class SpeedHandler(BaseHTTPRequestHandler):
    server_version = "wispbaby-dev-speed"
    protocol_version = "HTTP/1.1"  # keep-alive

    def _range(self):
        m = RANGE.match(self.path.split("?", 1)[0])
        if not m:
            self._empty(404)
            return None
        a, b = int(m.group(1)), int(m.group(2))
        if b < a:
            self._empty(400)
            return None
        return min(b - a + 1, CAP)

    def _empty(self, code, close=False):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()

    def do_GET(self, head=False):
        count = self._range()
        if count is None:
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(count))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if head:
            return
        left = count
        while left > 0:
            n = min(left, CHUNK)
            self.wfile.write(BUF if n == CHUNK else memoryview(BUF)[:n])
            STATS.add_test_bytes(n)
            left -= n

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_POST(self):
        if self._range() is None:
            return
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            self._empty(411, close=True)  # chunked uploads are not read: send Content-Length
            return
        length = int(length)
        if length > CAP:
            self._empty(413, close=True)
            return
        left = length
        while left > 0:
            got = self.rfile.read(min(left, 65536))
            if not got:
                self.close_connection = True
                return
            left -= len(got)
            STATS.add_test_bytes(len(got))
        self._empty(200)

    def log_message(self, fmt, *args):
        if os.environ.get("WISPBABY_DEV_SPEED_LOG"):
            sys.stderr.write("speed %s %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="wisp.baby dev harness")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--speed-port", type=int, default=8081)
    ap.add_argument("--no-live", action="store_true", help="answer /live, /live/history and /you with 503")
    ap.add_argument("--no-domains", action="store_true", help="leave the by-domain fields out of /live and /live/history")
    args = ap.parse_args()
    FakeStats.enabled = not args.no_live
    FakeStats.domains_on = not args.no_domains

    if not os.path.isdir(SITE):
        sys.exit("serve.py: %s does not exist (site/)" % SITE)
    SiteHandler.where = {"site": "dev", "host": "localhost", "city": "Localhost", "country": "--",
                         "addr": "127.0.0.1", "speedPort": args.speed_port}

    site = Server(("127.0.0.1", args.port), SiteHandler)
    speed = Server(("127.0.0.1", args.speed_port), SpeedHandler)
    Thread(target=speed.serve_forever, daemon=True).start()
    print("serve.py: page   http://127.0.0.1:%d/?wisp=ws://127.0.0.1:6011/  (%s)" % (args.port, SITE), file=sys.stderr)
    print("serve.py: speed  http://127.0.0.1:%d/speedtest/range/A-B" % args.speed_port, file=sys.stderr)
    try:
        site.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        site.server_close()
        speed.shutdown()
        speed.server_close()


if __name__ == "__main__":
    main()
