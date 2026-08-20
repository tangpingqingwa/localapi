# LocalAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/localapi  
**Coverage v1:** United States + United Kingdom cities we have fixtures for

Public business card + public reviews. Not Google Places, not a Maps clone.

---

## 1. Product statement

Credit API for the public listing a user can already see on Google Maps: name, address, hours, rating, review texts.

One-line pitch: **Public place card and reviews as JSON. $19/mo, not Places SKU math.**

UI must not look like Google Maps. Copy says “public business information.”

---

## 2. Goals and non-goals

### Goals

- `GET /v1/places/by-url` 1 credit; reviews 1 credit / page.
- Empty / blocked = 0 credits.
- Search credits published like StayingAPI (per result, min documented).
- US + UK fixtures: 30 restaurants/shops.
- Hard daily credit/proxy cap per key.

### Non-goals

- Directions, traffic, Street View, live busy-ness graphs.
- Writing reviews or Q&A.
- Implied Google partnership.
- Worldwide coverage.
- Photo hosting CDN.
- Apple Maps in v1 (mention as later).

---

## 3. Auth and envelope

Bearer `lk_live_...`. Shared envelope.

| code | HTTP | meaning |
|---|---|---|
| `invalid_place_url` | 400 | not a Maps place URL |
| `place_not_found` | 404 | |
| `region_unsupported` | 422 | outside US/UK v1 |
| `search_too_broad` | 400 | bbox/query missing city or exceeds max |
| `daily_cap` | 429 | key burned daily proxy budget |
| `upstream_blocked` | 503 | |

---

## 4. Endpoints

### 4.1 `GET /v1/places/by-url`

**Credits:** 1.

Accepts Google Maps place URLs (`maps.google.com`, `google.com/maps`, `maps.app.goo.gl`). Resolve shorts.

### 4.2 `GET /v1/places/{id}`

**Credits:** 1. `id` is **our** opaque id (`plc_...`), not a promise of Google’s `place_id`. If we store a vendor id internally, do not require customers to send it.

`data`:

```ts
{
  id: string
  name: string
  address: {
    line1: string | null
    city: string | null
    region: string | null
    postal: string | null
    country: "US" | "GB"
    formatted: string
  }
  location: { lat: number, lng: number } | null
  phone: string | null          // only if public
  website: string | null
  rating: { average: number | null, count: number | null }
  hours: Hours | null
  categories: string[]
  mapsUrl: string
  fetchedAt: string
}

type Hours = {
  timezone: string | null
  weekly: Array<{ day: 0|1|2|3|4|5|6, open: string, close: string }> // 0=Sun, HH:MM
  note: string | null
}
```

### 4.3 `GET /v1/places/{id}/reviews`

**Credits:** 1 / page. Query: `page`, `lang` (optional).

```ts
{
  page: number
  hasMore: boolean
  language: string | null
  reviews: Array<{
    id: string | null
    author: string | null
    stars: number
    text: string
    createdAt: string | null
    language: string | null
  }>
}
```

### 4.4 `GET /v1/places/{id}/hours`

**Credits:** 1. Subset of 4.2 for cheap refresh. If hours already in a warm product cache, still 1 credit (simple accounting).

### 4.5 `POST /v1/search` or `GET /v1/search`

**Credits:** 1 per result returned, **minimum 3** if any platform fan-out succeeds (document on pricing). Cap `limit` 20.

Query: `q` + `city` or `bbox=w,s,e,n`. Missing both → `search_too_broad`.

Do not advertise “near me” without a coordinate; we are not a mobile SDK.

### 4.6 Control plane

`/v1/me` includes `dailyRemaining`. `/v1/usage`, `/healthz`.

---

## 5. Billing

| Plan | Price | Credits | Daily cap (default) |
|---|---|---|---|
| Free | $0 | 100 once | 50 / day |
| Monthly | $19 | 2,000 | 500 / day |
| Annual | $190 | 2,000 / mo | 500 / day |

Top-up $10 / 1k. Daily cap protects proxy. Enterprise can raise cap later.

Pricing page must show a table vs current Google Places SKU list (updated quarterly).

---

## 6. Caching

| Resource | TTL |
|---|---|
| Place card | 24h |
| Hours | 24h |
| Reviews | 6–12h |
| Search | 6h |

Photos: do not store; omit or URL-only if unavoidable. Prefer omit in v1 to reduce legal surface.

---

## 7. MCP

Streamable HTTP at `POST /mcp`. Same Bearer keys as REST. Tools wrap `core/*` 1:1:

| tool | REST | credits |
|---|---|---|
| `get_place` | `GET /v1/places/by-url` or `GET /v1/places/{id}` | 1 |
| `list_reviews` | `GET /v1/places/{id}/reviews` | 1 / page |
| `search_places` | `GET /v1/search` | `max(3, n)` if any hit, else 0 |

Skill: US/UK; not for navigation; ratings are public snapshots; do not impersonate Google.

Public `GET /llms.txt` and `GET /.well-known/mcp/server-card.json`. Tool failures stay JSON-RPC HTTP 200 with `isError` and the REST error envelope in `structuredContent`. Auth failures stay the REST 401 envelope.

---

## 8. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | 30 fixture Maps URLs | 200, name + formatted address |
| 2 | Reviews page 1 | stars + text or empty |
| 3 | Search `coffee` + `Austin` | ≥3 results or documented empty |
| 4 | Search without city | 400 search_too_broad, 0 credit |
| 5 | Non US/UK URL | 422, 0 credit |
| 6 | Daily cap | 429 daily_cap |
| 7 | Marketing site has no map tiles that clone Google | visual QA |

Dogfood: one neighborhood weekly “what got worse” note uses only this API.

---

## 9. Milestones

**M1:** by-url + id + 30 fixtures.  
**M2:** reviews + hours; keys; $19.  
**M3:** search + daily cap.  
**M4:** MCP + pricing comparison page.

Launch = M2.

---

## 10. Legal

No Maps lookalike UI (no yellow man, no identical pin palette, no “Google” in the wordmark). Customer contract: no impersonation, no review gating, no using data to spam the business phone. Independent index of public information.

## 11. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.

Default place lookup is the 30-place fixture adapter. A live Maps/Places adapter may be enabled with `LOCALAPI_LIVE=1` and `LOCALAPI_MAPS_API_KEY`; it is never required for CI. Failures still charge 0 credits. Same URL always produces the same `plc_` hash. Never invent a place id or a review.
