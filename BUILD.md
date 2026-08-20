# LocalAPI — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

US + UK fixtures only. UI of any future site **must not** clone Google Maps chrome. Keys `lk_live_`.

---

## 1. Stack

Node 22, Fastify, SQLite, fixture JSON for 30 places. Our ids `plc_…` — never require customers to send Google `place_id`.

Default adapter is fixtures. Live Maps/Places is env-gated (`LOCALAPI_LIVE=1` + `LOCALAPI_MAPS_API_KEY`) and must not run in CI.

---

## 2. Identity

```
maps URL / goo.gl → resolve → stable hash → plc_{base32}
```

Same URL always same `plc_`. Store vendor ids internally only.

---

## 3. Search billing

`GET /v1/search?q&city` or `bbox=`. Missing both → `search_too_broad` 400, 0 credits.  
Credits: `max(3, resultCount)` when any result, else 0. Cap 20 results.

Daily cap on key: default free 50 / paid 500. Exceed → `daily_cap` 429.

---

## 4. Hours

`day`: 0 Sunday … 6 Saturday. `open`/`close` `HH:MM` 24h. Overnight: two intervals, do not wrap a single interval past 24:00.

---

## 5. PR plan

### PR 1: Skeleton + keys + daily counters
- **Files:** ClipAPI pattern + `keys.daily_used`, `keys.daily_reset`
- **Dependencies:** None

### PR 2: Place by-url + by-id + 30 fixtures
- **Files:** core/place.ts, fixtures/places.json, routes, tests
- **Dependencies:** PR 1
- **Acceptance:** SPEC 1, 5

### PR 3: Reviews + hours
- **Files:** core/reviews.ts, core/hours.ts, tests
- **Dependencies:** PR 2
- **Acceptance:** SPEC 2

### PR 4: Search + daily_cap
- **Files:** core/search.ts, tests/search.test.ts
- **Dependencies:** PR 2
- **Acceptance:** SPEC 3, 4, 6

### PR 5: MCP
- **Files:** `src/mcp/server.ts`, `src/mcp/tools.ts`, `llms.txt`, `tests/mcp.test.ts`
- **Dependencies:** PR 4
- **Tools:** get_place, list_reviews, search_places — wrap `core/*` 1:1. Fixtures only.

### GA: live Maps/places adapter (env-gated)
- **Files:** `src/adapters/maps/*`, `src/core/adapter.ts`, `src/core/place-index.ts`
- **Dependencies:** PR 5
- **Gate:** `LOCALAPI_LIVE=1`. Default remains the 30-place fixture adapter.
- **CI:** `scripts/test.sh` stays offline. Live `fetch` is never required for green.
- Failures map to SPEC (`place_not_found`, `region_unsupported`, `upstream_blocked`, `invalid_place_url`). 0 credits.
- Same Maps URL always hashes to the same `plc_`. Never invent place ids or reviews.

No photo CDN in any PR. Omit photos in v1. Do not start a Dockerfile in this unit.
