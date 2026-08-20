# One-box image. Listen on $PORT. Do not set LOCALAPI_LIVE here.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# tsx is a devDependency; install the full lockfile before NODE_ENV=production.
RUN npm ci && npm cache clean --force

COPY src ./src
COPY fixtures ./fixtures
COPY llms.txt tsconfig.json ./

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    LOCALAPI_DATABASE=/app/data/localapi.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
