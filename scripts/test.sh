#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks (no Google / Maps).
# Live Maps adapter is env-gated (LOCALAPI_LIVE=1) and must not run here.
set -euo pipefail

unset LOCALAPI_LIVE || true
unset LOCALAPI_MAPS_API_KEY || true
export LOCALAPI_LIVE=0

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh llms.txt; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md BUILD.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

if [[ -d src ]]; then
  echo "== no live Maps in CI default path =="
  [[ -f src/adapters/maps/fixture.ts ]] || fail "missing fixture adapter"
  [[ -f src/adapters/maps/live.ts ]] || fail "missing live Maps adapter"
  [[ -f src/core/adapter.ts ]] || fail "missing PlacesAdapter contract"
  grep -q 'LOCALAPI_LIVE' src/adapters/index.ts \
    || fail "adapter selection must be env-gated on LOCALAPI_LIVE"
  # fetch / Places hosts are allowed only inside the env-gated live adapter.
  if grep -RInE --exclude-dir=adapters '(^|[^[:alnum:]_])(fetch|axios|got|undici)[[:space:]]*\(' src >/dev/null; then
    fail "live HTTP client call outside src/adapters"
  fi
  if grep -RInE --exclude-dir=adapters 'maps\.googleapis\.com|places\.googleapis\.com' src >/dev/null; then
    fail "live Maps/Places host outside src/adapters"
  fi
  if grep -RInE '(^|[^[:alnum:]_])(fetch|axios|got|undici)[[:space:]]*\(' src/adapters/maps/fixture.ts >/dev/null; then
    fail "fixture adapter must not open a network socket"
  fi
  [[ -f src/core/reviews.ts ]] || fail "missing src/core/reviews.ts"
  [[ -f src/core/hours.ts ]] || fail "missing src/core/hours.ts"
  [[ -f src/core/search.ts ]] || fail "missing src/core/search.ts"
  [[ -f tests/search.test.ts ]] || fail "missing tests/search.test.ts"
  [[ -f tests/live-maps.test.ts ]] || fail "missing tests/live-maps.test.ts"
  if [[ -d src/http ]]; then
    if grep -RInE 'from ["'\''](\.\./)*adapters/|from ["'\''][^"'\'']*fixtures/' src/http >/dev/null; then
      fail "HTTP layer must not import adapters or fixtures"
    fi
    grep -RInE 'from ["'\''][^"'\'']*core/' src/http >/dev/null \
      || fail "HTTP layer must import from core/*"
  fi
fi

echo "== MCP tools (PR 5) =="
[[ -f src/mcp/server.ts ]] || fail "missing src/mcp/server.ts"
[[ -f src/mcp/tools.ts ]] || fail "missing src/mcp/tools.ts"
[[ -f tests/mcp.test.ts ]] || fail "missing tests/mcp.test.ts"
[[ -f llms.txt ]] || fail "missing llms.txt"
grep -q 'get_place' src/mcp/tools.ts || fail "src/mcp/tools.ts missing get_place"
grep -q 'list_reviews' src/mcp/tools.ts || fail "src/mcp/tools.ts missing list_reviews"
grep -q 'search_places' src/mcp/tools.ts || fail "src/mcp/tools.ts missing search_places"
grep -q 'get_place' llms.txt || fail "llms.txt missing get_place"
grep -q 'list_reviews' llms.txt || fail "llms.txt missing list_reviews"
grep -q 'search_places' llms.txt || fail "llms.txt missing search_places"
grep -q 'When not to call' llms.txt || fail "llms.txt missing when-not-to-call"
grep -qi 'not for navigation' llms.txt || fail "llms.txt missing navigation disclaimer"
grep -qi 'impersonate' llms.txt || fail "llms.txt missing impersonation disclaimer"
if grep -RInE 'from ["'\''](\.\./)*adapters/|from ["'\''][^"'\'']*fixtures/' src/mcp >/dev/null; then
  fail "MCP layer must not import adapters or fixtures"
fi
grep -RInE 'from ["'\''][^"'\'']*core/' src/mcp >/dev/null \
  || fail "MCP layer must import from core/*"
if grep -RInE --include='*.ts' '(^|[^[:alnum:]_])(fetch|axios|got|undici)[[:space:]]*\(' src/mcp >/dev/null; then
  fail "live HTTP client call in src/mcp; fixtures only"
fi
if grep -RInE --include='*.ts' 'maps\.googleapis\.com|places\.googleapis\.com' src/mcp >/dev/null; then
  fail "src/mcp must not call live Maps/Places hosts"
fi

if [[ -f fixtures/places.json ]]; then
  echo "== fixture catalog =="
  python3 - "$root/fixtures/places.json" <<'PY' || fail "fixtures/places.json is not 30 valid US/UK places"
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if not isinstance(data, list):
    raise SystemExit("fixtures/places.json must be an array")
if len(data) != 30:
    raise SystemExit(f"expected 30 fixtures, got {len(data)}")
slugs = set()
for i, row in enumerate(data):
    if not isinstance(row, dict):
        raise SystemExit(f"[{i}] not an object")
    name = row.get("name") or ""
    addr = row.get("address") or {}
    formatted = addr.get("formatted") or ""
    country = addr.get("country")
    slug = row.get("slug") or ""
    maps = row.get("mapsUrl") or ""
    if not name or not formatted or not slug or not maps:
        raise SystemExit(f"[{i}] missing name/formatted/slug/mapsUrl")
    if country not in ("US", "GB"):
        raise SystemExit(f"[{i}] country must be US or GB")
    if slug in slugs:
        raise SystemExit(f"duplicate slug {slug}")
    slugs.add(slug)
print(f"30 fixtures ({sum(1 for r in data if r['address']['country']=='US')} US / {sum(1 for r in data if r['address']['country']=='GB')} GB)")
PY
fi

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  # Fixture adapter only — never hit live Maps / Places.
  export LOCALAPI_LIVE=0
  unset LOCALAPI_MAPS_API_KEY || true
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
