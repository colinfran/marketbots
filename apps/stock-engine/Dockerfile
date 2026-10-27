# syntax=docker/dockerfile:1.7
#
# Stock engine image. Build from the repository root:
#   docker compose build stock-engine       (uses compose.yml)
#   docker build -f apps/stock-engine/Dockerfile .
#
# Linux image (Docker Desktop / WSL2 on Windows runs it as-is).

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ── 1. Build the engine bundle ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
# Every locked package, from the lockfile alone: this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY packages packages
COPY apps/stock-engine apps/stock-engine
# The other apps' manifests keep the workspace lockfile consistent; their code isn't needed here.
COPY apps/stock-web/package.json apps/stock-web/
COPY apps/crypto-engine/package.json apps/crypto-engine/
COPY apps/crypto-web/package.json apps/crypto-web/
RUN pnpm install --offline --frozen-lockfile --filter "@mb/stock-engine..."
RUN pnpm --filter @mb/stock-engine build

# ── 2. Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    STREAM_HOST=0.0.0.0 \
    STREAM_PORT=8788
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/stock-engine/dist ./dist
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STREAM_PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM for a graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
