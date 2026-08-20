# Live Maps/Places smoke

Optional soak. **Not** part of `scripts/test.sh` or GitHub Actions `ci`.

## Status (this session)

**BLOCKED-SECRET**

`LOCALAPI_MAPS_API_KEY` was unset in the implementer environment. Required live flows were not run. No key was invented. No place was invented.

| Flow | Result |
|---|---|
| `GET /v1/places/by-url` with a real Maps URL | BLOCKED-SECRET |
| `GET /v1/search?q=coffee&city=Austin` | BLOCKED-SECRET |
| Same Maps URL → same `plc_` | BLOCKED-SECRET |

`bash scripts/test.sh` stays the offline gate and must stay green without this key.

## How to run

```bash
export LOCALAPI_MAPS_API_KEY=   # real Places API key; never commit
bash scripts/live-smoke.sh
```

The script starts a local `npm start` with `LOCALAPI_LIVE=1`, a temp SQLite file, and bootstrap key `lk_test_live_smoke` (override with `LOCALAPI_BOOTSTRAP_KEY`).

Default place URL is the public Franklin Barbecue Maps listing. Override with `LOCALAPI_LIVE_PLACE_URL`. Default search is `coffee` + `Austin` (SPEC §8 case 3). Override with `LOCALAPI_LIVE_SEARCH_Q` / `LOCALAPI_LIVE_SEARCH_CITY`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | PASS — live process walked every required flow |
| 1 | FAIL — process started but a required flow failed |
| 2 | BLOCKED-SECRET — no `LOCALAPI_MAPS_API_KEY` |

Do not point this script at fixtures. Do not add it to CI. Do not bake a Maps key into the image or `.env.example`.
