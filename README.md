# LocalAPI

Build contract: [SPEC.md](./SPEC.md).
How we work: [CONTRIBUTING.md](./CONTRIBUTING.md). `main` stays buildable and testable.
How we build: [BUILD.md](./BUILD.md) — stack, modules, tests, PR sequence.

Public business listings and reviews from Google Maps (and later Apple Maps) as a credit API.

Google Places is official and metered like a luxury good. Most people need “reviews for this shop” or “businesses in this box,” not the whole Places platform.

## Why this, and why overseas

US/EU local SEO, reputation tools, and “agent, find me a dentist and summarize the complaints” all hit the same wall: Places SKUs add up, and scraping Maps breaks weekly. Search volume on `google reviews api` and `google maps api expensive` is not theoretical.

This is ZillAPI’s shape applied to local: public page data, same-day key, surgical endpoints.

## Exact demand

- Who: local SEO indies, reputation monitors, travel/city agents, lead-enrichment scripts
- Input: Maps URL, `place_id` if we have one, or a text query + city
- Output: name, address, hours, rating, review count, phone if public, review texts with stars and time
- Acceptance: `GET /v1/places/by-url` one credit; `GET /v1/places/{id}/reviews` one credit per page; empty/blocked 0

## Exact connector

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/places/by-url` | One business | 1 |
| `/v1/places/{id}` | One business | 1 |
| `/v1/places/{id}/reviews` | Review page | 1 |
| `/v1/search` | Text or bbox | 1 / result (cap documented) |
| `/v1/places/{id}/hours` | Hours only | 1 |

US + UK cities first. Do not claim “every country.”

MCP: `get_place`, `list_reviews`, `search_places`.

## Exact combination

- SEO: `Google Places API pricing 2026` and `cheapest google reviews api`
- Free 100 credits
- $19 / mo / 2,000 — Places’ own price list is the comparison chart
- DailyBrief later: “these five restaurants, new 1-star reviews”
- No consumer Maps clone

## Cost control

- Place records cache 24h; reviews 6–12h
- Search is the expensive call; publish the credit math like StayingAPI
- Photos as URLs, no image CDN
- Hard daily cap per key so one customer cannot eat the proxy budget

## Business model

Credits against Google’s official bill. The pitch is not “illegal Places.” It is “public listing card and public reviews, predictable cents.”

Success: 10 paying local-SEO or agent customers; support tickets are about fields, not about empty payloads; proxy < 25% of revenue.

## Adapters

Default is the 30-place US/UK fixture catalog. Live Google Places is opt-in:

```bash
LOCALAPI_LIVE=1 LOCALAPI_MAPS_API_KEY=... npm start
```

CI and `bash scripts/test.sh` never set `LOCALAPI_LIVE`. Failures (`place_not_found`, `region_unsupported`, `upstream_blocked`) charge 0 credits. Same Maps URL always hashes to the same `plc_`. No photos, no photo CDN.

## Will not do

- No directions, no live traffic, no Street View
- No write reviews, no Q&A spam
- No implied Google partnership
- No worldwide coverage in the first year

## First two weeks

1. by-url for 30 US restaurant/shop fixtures
2. Reviews pagination + language field
3. OpenAPI + MCP `get_place`
4. A pricing table next to current Places SKU prices

## Dogfood

Pick a neighborhood we actually use. A weekly “what got worse nearby” note must come from LocalAPI. If we open Maps to read reviews, the product is lying.

## Risk

Google is litigious about Maps lookalikes. UI must not clone Maps. Copy talks about public business information. Customer contract bans impersonation and review gating tricks.
