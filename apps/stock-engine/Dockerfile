# syntax=docker/dockerfile:1.7
#
# StockMarketBot engine image. Build from the repository root:
#   docker compose build            (uses docker-compose.yml)
#   docker build -f apps/engine/Dockerfile .
#
# Linux image (Docker Desktop / WSL2 on Windows runs it as-is).

# ── 1. Build the engine bundle ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/engine/package.json apps/engine/
# The web app's manifest keeps the workspace lockfile consistent; its code isn't needed here.
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@mb/stock-engine..."
COPY packages/core packages/core
COPY apps/engine apps/engine
RUN pnpm --filter @mb/stock-engine build

# ── 2. Runtime ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    STREAM_HOST=0.0.0.0 \
    STREAM_PORT=8788
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/engine/dist ./dist
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STREAM_PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM for a graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
