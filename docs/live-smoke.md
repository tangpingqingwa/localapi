# Live Maps smoke

Optional soak. **Not** part of `scripts/test.sh` or GitHub Actions `ci`.

Live default is the **public Google Maps place page** (and/or documented public JSON embedded in that page). No Places API key. `LOCALAPI_MAPS_API_KEY` remains an optional Places SKU path.

## Status (this session)

**PASS**

`LOCALAPI_MAPS_API_KEY` was unset. `LOCALAPI_LIVE=1` fetched the public Franklin Barbecue Maps listing. Name and formatted address came from the public page. Same URL hashed to the same `plc_`. Search `coffee` + `Austin` returned live public hits. No key was invented. No place was invented.

| Flow | Result |
|---|---|
| `GET /v1/places/by-url` with a real Maps URL (Franklin Barbecue, Austin) | **PASS** — `plc_toapxyuaeqb455zi`, name `Franklin Barbecue`, address `Franklin Barbecue, 900 E 11th St, Austin, TX 78702` |
| Same Maps URL → same `plc_` | **PASS** — `plc_toapxyuaeqb455zi` |
| `GET /v1/search?q=coffee&city=Austin` | **PASS** — 20 public hits |

`bash scripts/test.sh` stays the offline gate (95/95 this session) and must stay green without this network.

## How to run

```bash
bash scripts/live-smoke.sh
```

The script starts a local `npm start` with `LOCALAPI_LIVE=1`, a temp SQLite file, and bootstrap key `lk_test_live_smoke` (override with `LOCALAPI_BOOTSTRAP_KEY`). A Places SKU key is **not** required.

Default place URL is the public Franklin Barbecue Maps listing. Override with `LOCALAPI_LIVE_PLACE_URL`. Default search is `coffee` + `Austin` (SPEC §8 case 3). Override with `LOCALAPI_LIVE_SEARCH_Q` / `LOCALAPI_LIVE_SEARCH_CITY`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | PASS — live process walked every required flow with a real name+address, **or** PASS-ERROR — honest `upstream_blocked` 503 / 0 credits (bot wall, captcha, unparseable HTML) |
| 1 | FAIL — process started but a required flow failed, or a row was invented |
| 2 | BLOCKED-SECRET — paid SKU-only leftover after public-page live was attempted (not used when the public page path runs) |

Do not point this script at fixtures. Do not add it to CI. Do not bake a Maps key into the image or `.env.example`.
