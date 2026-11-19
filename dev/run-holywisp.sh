#!/usr/bin/env bash
# Local holyWisp for the wisp.baby dev harness (README.md).
#
#   dev/run-holywisp.sh          # ws://127.0.0.1:6011/
#   python3 dev/serve.py         # http://127.0.0.1:8080/ (+ :8081 speed test)
#   open http://127.0.0.1:8080/?wisp=ws://127.0.0.1:6011/
#
# Fetches the published npm package holywisp@0.5.2 into ~/.cache/wispbaby/holywisp-dev/, checks the
# tarball against its pinned sha512 integrity, extracts only bin/<platform>/holywisp, writes a dev
# config and runs it in the foreground (Ctrl+C stops it).
#
# HOLYWISP_BIN=/path/to/holywisp runs that binary instead (a local holyWisp build; nothing is
# fetched). If the binary has WebTransport (its --help lists `webtransport`), the dev config turns
# it on: UDP 127.0.0.1:$PORT with a rotating self-signed certificate, described at
# http://127.0.0.1:$PORT/webtransport.json (URL and certificate hashes), which is where the page
# looks when it has ?wisp=ws://127.0.0.1:$PORT/. The npm 0.5.2 build has no WebTransport, so the
# page then runs over WebSocket.
#
# The dev config is NOT the edge config: it allows loopback, private and literal-IP destinations
# (the page's G-Core mode dials 127.0.0.1:8081, serve.py's speed test), has no SOCKS5 router, no
# UDP and no reputation store. Bound to 127.0.0.1 only. Never use it on a public interface.
set -euo pipefail

VERSION=0.5.2
INTEGRITY="sha512-mJ0hRpSDh9JJ16+0ERXg9/DOFPJbPKKw+14cmUYP16XLQ/9+u6I2qdIgpxHHrRRohtulsP3NwepZmVvJsVl2WQ=="
REGISTRY=https://registry.npmjs.org
PORT="${HOLYWISP_DEV_PORT:-6011}"
CACHE="${HOME}/.cache/wispbaby/holywisp-dev"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PLATFORM=linux-x64 ;;
  Linux-aarch64) PLATFORM=linux-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64 ;;
  Darwin-arm64)  PLATFORM=darwin-arm64 ;;
  *) echo "run-holywisp: no known holywisp platform for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

die() { echo "run-holywisp: $*" >&2; exit 1; }

sri_sha512() {  # file -> sha512-<base64>, as npm's dist.integrity spells it
  if command -v openssl >/dev/null 2>&1; then
    printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n')"
  else
    python3 -I -c 'import base64,hashlib,sys; print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode(), end="")' "$1"
  fi
}

mkdir -p "$CACHE"
TGZ="$CACHE/holywisp-$VERSION.tgz"
BINDIR="$CACHE/$VERSION/$PLATFORM"
BIN="$BINDIR/holywisp"

if [[ -n "${HOLYWISP_BIN:-}" ]]; then
  [[ -x "$HOLYWISP_BIN" ]] || die "HOLYWISP_BIN=$HOLYWISP_BIN is not an executable"
  BIN="$HOLYWISP_BIN"
else

# 1. The tarball, checked every run (a cached copy that no longer matches is fetched again).
if [[ ! -f "$TGZ" || "$(sri_sha512 "$TGZ")" != "$INTEGRITY" ]]; then
  rm -f "$TGZ" "$BIN"
  echo "run-holywisp: fetching holywisp@$VERSION from $REGISTRY" >&2
  curl -fsSL --proto '=https' --max-time 300 -o "$TGZ.part" "$REGISTRY/holywisp/-/holywisp-$VERSION.tgz"
  got="$(sri_sha512 "$TGZ.part")"
  if [[ "$got" != "$INTEGRITY" ]]; then
    rm -f "$TGZ.part"
    die "integrity mismatch for holywisp-$VERSION.tgz: got $got, want $INTEGRITY"
  fi
  mv -f "$TGZ.part" "$TGZ"
fi

# 2. Only package/bin/<platform>/holywisp, as a regular file.
if [[ ! -x "$BIN" ]]; then
  member="package/bin/$PLATFORM/holywisp"
  kind="$(tar -tvzf "$TGZ" "$member" 2>/dev/null | cut -c1)" || true
  [[ "$kind" == "-" ]] || die "$member is missing from the tarball or is not a regular file"
  rm -rf "$BINDIR.tmp"; mkdir -p "$BINDIR.tmp"
  tar -xzf "$TGZ" -C "$BINDIR.tmp" --no-same-owner --no-same-permissions --strip-components=3 "$member"
  chmod 0755 "$BINDIR.tmp/holywisp"
  rm -rf "$BINDIR"; mv "$BINDIR.tmp" "$BINDIR"
fi
fi  # HOLYWISP_BIN

# 3. The dev config.
CONF="$CACHE/holywisp-dev.conf"
cat > "$CONF" <<EOF
# holyWisp dev config, written by dev/run-holywisp.sh (overwritten every run).
host = 127.0.0.1
port = $PORT
workers = 0
log-level = info

allow-tcp = on
allow-udp = off
allow-direct-ip = on
allow-private = on
allow-loopback = on
allow-link-local = off

enable-v2 = on
enable-twisp = off
password-required = off
buffer-remaining = 128

flood-protection = off
reputation = off

max-message-size = 262149
stream-queue-max = 67108864
ws-write-high-water = 8388608
tcp-nodelay = on
non-ws-response = "Upgrade Required"
serve-webclient = off
EOF
if "$BIN" --help 2>&1 | grep -q '^ *webtransport '; then
  printf '\n# WebTransport on UDP 127.0.0.1:%s, self-signed (hashes in /webtransport.json).\nwebtransport = on\n' "$PORT" >> "$CONF"
fi

echo "run-holywisp: $("$BIN" --version) on ws://127.0.0.1:$PORT/ (config $CONF)" >&2
exec "$BIN" --config "$CONF"
