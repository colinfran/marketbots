# syntax=docker/dockerfile:1.7
#
# Crypto engine image. Build from the repository root:
#   docker compose build crypto-engine      (uses compose.yml)
#   docker build -f apps/crypto-engine/Dockerfile .
#
# Linux image (Docker Desktop / WSL2 on Windows runs it as-is). Debian-based because the
# official Kraken CLI release is built against glibc.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ── 1. Build the engine bundle ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
# Every locked package, from the lockfile alone: this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY packages packages
COPY apps/crypto-engine apps/crypto-engine
# The other apps' manifests keep the workspace lockfile consistent; their code isn't needed here.
COPY apps/crypto-web/package.json apps/crypto-web/
COPY apps/stock-engine/package.json apps/stock-engine/
COPY apps/stock-web/package.json apps/stock-web/
RUN pnpm install --offline --frozen-lockfile --filter "@mb/crypto-engine..."
RUN pnpm --filter @mb/crypto-engine build

# ── 2. Fetch the official Kraken CLI, pinned and checksum-verified ────────────
FROM debian:bookworm-slim AS kraken-cli
ARG KRAKEN_CLI_VERSION=0.4.1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) target=x86_64-unknown-linux-gnu ;; \
    arm64) target=aarch64-unknown-linux-gnu ;; \
    *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/krakenfx/kraken-cli/releases/download/v${KRAKEN_CLI_VERSION}"; \
  curl -fsSL -o /tmp/cli.tar.gz "${base}/kraken-cli-${target}.tar.gz"; \
  curl -fsSL -o /tmp/cli.sha256 "${base}/kraken-cli-${target}.tar.gz.sha256"; \
  echo "$(cut -d' ' -f1 /tmp/cli.sha256)  /tmp/cli.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/cli.tar.gz -C /tmp; \
  install -m 0755 "/tmp/kraken-cli-${target}/kraken" /usr/local/bin/kraken

# ── 3. Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    KRAKEN_CLI_PATH=/usr/local/bin/kraken \
    # Everything the Kraken CLI writes (the paper wallet journal) lives on the /data/kraken volume.
    HOME=/data/kraken/home \
    XDG_CONFIG_HOME=/data/kraken/config \
    XDG_DATA_HOME=/data/kraken/data \
    XDG_CACHE_HOME=/tmp/cache \
    STREAM_HOST=0.0.0.0 \
    STREAM_PORT=8787
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/kraken/home /data/kraken/config /data/kraken/data \
  && chown -R node:node /data
COPY --from=kraken-cli /usr/local/bin/kraken /usr/local/bin/kraken
# Fail the build now, not at runtime, if the CLI can't run on this base image.
RUN kraken --version
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/crypto-engine/dist ./dist
USER node
EXPOSE 8787
VOLUME ["/data/kraken"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STREAM_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini reaps the short-lived Kraken CLI processes and forwards SIGTERM for a graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
