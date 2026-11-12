#!/usr/bin/env python3
"""
wisp.baby local dev harness (README.md). Python 3 stdlib only.

    python3 dev/serve.py
    dev/run-holywisp.sh        # in another terminal: ws://127.0.0.1:6011/
    open http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/

http://127.0.0.1:8080  the page (site/), GET /where (dev JSON), the same
                       security headers as the boxes, with a CSP that also lets the page reach
                       ws://127.0.0.1:* (the dev holyWisp).
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
import os
import re
import sys
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
        if path != "/where":
            self.send_header("Cache-Control", "no-cache")  # dev: always revalidate
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/where":
            body = json.dumps(self.where, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
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
        self._empty(200)

    def log_message(self, fmt, *args):
        if os.environ.get("WISPBABY_DEV_SPEED_LOG"):
            sys.stderr.write("speed %s %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="wisp.baby dev harness")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--speed-port", type=int, default=8081)
    args = ap.parse_args()

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
