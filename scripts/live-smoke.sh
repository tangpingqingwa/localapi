#!/usr/bin/env bash
# Optional live Maps/Places soak. Never called from scripts/test.sh or CI.
# Gate: LOCALAPI_LIVE=1 + a real LOCALAPI_MAPS_API_KEY.
# Required flows: place by a real Maps URL; search + city; same URL → same plc_.
# Missing key → BLOCKED-SECRET (exit 2). Do not invent a key or a place.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

blocked_secret() {
  echo "BLOCKED-SECRET: $*"
  echo "Required flows not run:"
  echo "  - GET /v1/places/by-url against a real Maps place URL"
  echo "  - GET /v1/search?q&city against live Places"
  echo "  - same Maps URL → same plc_"
  echo "Export a real Places API key as LOCALAPI_MAPS_API_KEY and re-run."
  echo "Do not invent a key. Do not invent a place."
  exit 2
}

if [[ -z "${LOCALAPI_MAPS_API_KEY:-}" ]]; then
  blocked_secret "LOCALAPI_MAPS_API_KEY is unset or empty."
fi

# Well-known public listing (Franklin Barbecue, Austin). Not a fixture-only id.
# Live adapter resolves via Places text search + coords; we never invent plc_.
MAPS_URL="${LOCALAPI_LIVE_PLACE_URL:-https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z}"
SEARCH_Q="${LOCALAPI_LIVE_SEARCH_Q:-coffee}"
SEARCH_CITY="${LOCALAPI_LIVE_SEARCH_CITY:-Austin}"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/localapi-live-smoke.XXXXXX")"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

port="$(
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
[[ -n "$port" ]] || fail "could not pick a listen port"

export NODE_ENV=development
export PORT="$port"
export LOCALAPI_LIVE=1
export LOCALAPI_DATABASE="$tmp/localapi.sqlite"
export LOCALAPI_BOOTSTRAP_KEY="${LOCALAPI_BOOTSTRAP_KEY:-lk_test_live_smoke}"
# Keep the operator key; do not print it.
export LOCALAPI_MAPS_API_KEY

echo "== start local process LOCALAPI_LIVE=1 port=${port} =="
npm start >"$tmp/server.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "---- server log ----" >&2
    cat "$tmp/server.log" >&2 || true
    fail "server exited before /healthz"
  fi
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
[[ "$ready" -eq 1 ]] || fail "server never answered /healthz"

auth=(-H "Authorization: Bearer ${LOCALAPI_BOOTSTRAP_KEY}")
base="http://127.0.0.1:${port}"

echo "== GET /v1/places/by-url (real Maps URL) =="
place1="$(curl -fsS "${auth[@]}" \
  "${base}/v1/places/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MAPS_URL")")" \
  || fail "by-url request failed"

id1="$(
  python3 - "$place1" <<'PY'
import json, sys
body = json.loads(sys.argv[1])
if "error" in body:
    raise SystemExit(f"by-url error {body['error']}")
place = body["data"]
pid = place.get("id") or ""
name = place.get("name") or ""
formatted = ((place.get("address") or {}).get("formatted")) or ""
if not pid.startswith("plc_"):
    raise SystemExit(f"expected plc_ id, got {pid!r}")
if not name or not formatted:
    raise SystemExit("place missing name or formatted address")
charged = (body.get("meta") or {}).get("creditsCharged")
if charged != 1:
    raise SystemExit(f"expected 1 credit, got {charged!r}")
print(pid)
PY
)" || fail "by-url payload is not a live place card"

echo "place id=${id1}"

echo "== GET /v1/places/by-url again (same URL → same plc_) =="
place2="$(curl -fsS "${auth[@]}" \
  "${base}/v1/places/by-url?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MAPS_URL")")" \
  || fail "second by-url request failed"

id2="$(
  python3 - "$place2" "$id1" <<'PY'
import json, sys
body = json.loads(sys.argv[1])
want = sys.argv[2]
place = body["data"]
pid = place.get("id") or ""
if pid != want:
    raise SystemExit(f"plc_ mismatch: first={want} second={pid}")
print(pid)
PY
)" || fail "same Maps URL did not hash to the same plc_"

echo "repeat id=${id2}"

echo "== GET /v1/search?q=${SEARCH_Q}&city=${SEARCH_CITY} =="
search="$(curl -fsS "${auth[@]}" \
  "${base}/v1/search?q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SEARCH_Q")&city=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SEARCH_CITY")")" \
  || fail "search request failed"

python3 - "$search" <<'PY' || fail "search payload is not a live result page"
import json, sys
body = json.loads(sys.argv[1])
if "error" in body:
    raise SystemExit(f"search error {body['error']}")
page = body["data"]
results = page.get("results")
if not isinstance(results, list):
    raise SystemExit("search missing results[]")
if len(results) == 0:
    raise SystemExit("live search returned 0 results; expected real Places hits")
for i, hit in enumerate(results):
    pid = (hit or {}).get("id") or ""
    name = (hit or {}).get("name") or ""
    if not pid.startswith("plc_"):
        raise SystemExit(f"results[{i}] missing plc_ id")
    if not name:
        raise SystemExit(f"results[{i}] missing name")
print(f"{len(results)} hits")
PY

echo "OK: live smoke walked by-url, search+city, and stable plc_"
exit 0
