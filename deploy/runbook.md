# LocalAPI — one-VPS runbook

Single Docker host. SQLite on a named volume. The adapter stays on the 30-place US/UK fixture catalog until you opt into live Maps/Places.

## Env

Copy [`.env.example`](../.env.example) to `/etc/localapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `LOCALAPI_DATABASE` | required; must sit on the volume, e.g. `/app/data/localapi.sqlite` |
| `LOCALAPI_BOOTSTRAP_KEY` | optional first `lk_live_...` when the keys table is empty |
| `LOCALAPI_LIVE` | leave `0` (or unset) until soak |
| `LOCALAPI_MAPS_API_KEY` | optional Places SKU path when `LOCALAPI_LIVE=1`; public Maps pages work without it |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t localapi:local .
docker run -d --name localapi --restart unless-stopped --init \
  --env-file /etc/localapi.env \
  -p 127.0.0.1:3000:3000 \
  -v localapi-data:/app/data \
  localapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). The data volume must be writable by that uid. Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $LOCALAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

## Enable live Maps/Places

1. Confirm `/healthz` is green with live off (fixture adapter).
2. Set `LOCALAPI_LIVE=1`. Public Maps place pages work without `LOCALAPI_MAPS_API_KEY`. Set the key only for the optional Places SKU path.
3. Recreate the container. Same Maps URL always hashes to the same `plc_`.
4. Failures map to SPEC (`invalid_place_url`, `place_not_found`, `region_unsupported`, `upstream_blocked`) and charge 0 credits. Never invent a place id or a review. Bot wall / captcha / unparseable HTML is `upstream_blocked` 503, 0 credits.
5. Leave the flag unset in CI. `scripts/test.sh` unsets `LOCALAPI_LIVE` / `LOCALAPI_MAPS_API_KEY`.

Optional soak after enable: `bash scripts/live-smoke.sh` (record in [docs/live-smoke.md](../docs/live-smoke.md)). Default is a real public Maps URL (Franklin Barbecue, Austin). Missing Places SKU key is not `BLOCKED-SECRET`. Not part of CI.

Roll back: set `LOCALAPI_LIVE=0` (or unset) and recreate. Do not run live Maps from CI.

## Data

Back up the SQLite file on the volume. The bootstrap key is inserted only when the `keys` table is empty. No photo CDN.
