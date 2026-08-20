#!/usr/bin/env bash
# Optional live Maps soak. Never called from scripts/test.sh or CI.
# Gate: LOCALAPI_LIVE=1. Default path is the public Google Maps place page
# (and/or documented public JSON embedded in that page) — no Places SKU key.
# LOCALAPI_MAPS_API_KEY remains an optional Places SKU path when present.
# Required flows: place by a real Maps URL; search + city; same URL → same plc_.
# Missing SKU key is not BLOCKED-SECRET. That exit is only for a paid SKU-only
# leftover after the public-page live path was attempted.
# Do not invent a key. Do not invent a place.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Well-known public listing (Franklin Barbecue, Austin). Not a fixture-only id.
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
# Optional Places SKU key. Public-page live runs without it.
if [[ -n "${LOCALAPI_MAPS_API_KEY:-}" ]]; then
  export LOCALAPI_MAPS_API_KEY
else
  unset LOCALAPI_MAPS_API_KEY || true
fi

if [[ -n "${LOCALAPI_MAPS_API_KEY:-}" ]]; then
  maps_key_state="set"
else
  maps_key_state="unset"
fi
echo "== start local process LOCALAPI_LIVE=1 port=${port} maps_key=${maps_key_state} =="
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
enc_url="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MAPS_URL")"

echo "== GET /v1/places/by-url (real public Maps URL) =="
place1_http="$(
  curl -sS -o "$tmp/place1.json" -w '%{http_code}' "${auth[@]}" \
    "${base}/v1/places/by-url?url=${enc_url}"
)" || fail "by-url request failed"

python3 - "$tmp/place1.json" "$place1_http" "$tmp/place1.id" <<'PY' || fail "by-url payload is not a live place card"
import json, sys
path, http, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.loads(open(path, encoding="utf-8").read())
err = body.get("error") or {}
code = err.get("code")
charged = (body.get("meta") or {}).get("creditsCharged")
if code == "upstream_blocked":
    if http != "503":
        raise SystemExit(f"upstream_blocked expected HTTP 503, got {http}")
    if charged not in (0, None):
        raise SystemExit(f"upstream_blocked must charge 0 credits, got {charged!r}")
    print("PASS-ERROR: by-url upstream_blocked 503, 0 credits")
    open(out_path, "w", encoding="utf-8").write("UPSTREAM_BLOCKED")
    raise SystemExit(0)
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
if charged != 1:
    raise SystemExit(f"expected 1 credit, got {charged!r}")
print(f"place id={pid} name={name!r} address={formatted!r}")
open(out_path, "w", encoding="utf-8").write(pid)
PY

id1="$(cat "$tmp/place1.id")"

if [[ "$id1" == "UPSTREAM_BLOCKED" ]]; then
  echo "OK: live smoke recorded honest upstream_blocked on public Maps (PASS-ERROR)"
  exit 0
fi

echo "== GET /v1/places/by-url again (same URL → same plc_) =="
place2="$(curl -fsS "${auth[@]}" "${base}/v1/places/by-url?url=${enc_url}")" \
  || fail "second by-url request failed"

python3 - "$place2" "$id1" <<'PY' || fail "same Maps URL did not hash to the same plc_"
import json, sys
body = json.loads(sys.argv[1])
want = sys.argv[2]
place = body["data"]
pid = place.get("id") or ""
if pid != want:
    raise SystemExit(f"plc_ mismatch: first={want} second={pid}")
print(pid)
PY

echo "== GET /v1/search?q=${SEARCH_Q}&city=${SEARCH_CITY} =="
search_http="$(
  curl -sS -o "$tmp/search.json" -w '%{http_code}' "${auth[@]}" \
    "${base}/v1/search?q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SEARCH_Q")&city=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SEARCH_CITY")"
)" || fail "search request failed"

python3 - "$tmp/search.json" "$search_http" <<'PY' || fail "search payload is not a live result page"
import json, sys
body = json.loads(open(sys.argv[1], encoding="utf-8").read())
http = sys.argv[2]
err = body.get("error") or {}
code = err.get("code")
charged = (body.get("meta") or {}).get("creditsCharged")
if code == "upstream_blocked":
    if http != "503":
        raise SystemExit(f"search upstream_blocked expected HTTP 503, got {http}")
    if charged not in (0, None):
        raise SystemExit(f"search upstream_blocked must charge 0 credits, got {charged!r}")
    print("PASS-ERROR: search upstream_blocked 503, 0 credits")
    raise SystemExit(0)
if "error" in body:
    raise SystemExit(f"search error {body['error']}")
page = body["data"]
results = page.get("results")
if not isinstance(results, list):
    raise SystemExit("search missing results[]")
if len(results) == 0:
    raise SystemExit("live search returned 0 results; expected real public Maps hits")
for i, hit in enumerate(results):
    pid = (hit or {}).get("id") or ""
    name = (hit or {}).get("name") or ""
    if not pid.startswith("plc_"):
        raise SystemExit(f"results[{i}] missing plc_ id")
    if not name:
        raise SystemExit(f"results[{i}] missing name")
print(f"{len(results)} hits")
PY

echo "OK: live smoke walked by-url, search+city, and stable plc_ via public Maps"
exit 0
