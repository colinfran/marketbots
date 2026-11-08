# syntax=docker/dockerfile:1.7
#
# A dashboard's image: its Next.js standalone server. One file for both, chosen by build arguments
# (compose.yml passes them):
#   APP   crypto-web | stock-web
#   CORE  the bot's core package: crypto-core | stock-core
#
#   docker compose build crypto-web
#   docker build -f docker/web/Dockerfile --build-arg APP=crypto-web --build-arg CORE=crypto-core .
#
# Only the app and the packages it uses are copied in, so a change elsewhere (an engine, the other
# bot, docs) leaves every layer cached and the image identical: compose then keeps the running
# container (docker/web/autodeploy.mjs, which runs at every commit to main, relies on that). Nothing reads the database or a secret at
# build time: every page awaits connection(), and the variables arrive at runtime.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ── 1. Build ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ARG APP
ARG CORE
# Written into the browser code by `next build` (NEXT_PUBLIC_*), so it is a build argument.
ARG NEXT_PUBLIC_DISPLAY_TIMEZONE=America/Los_Angeles
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_DISPLAY_TIMEZONE=${NEXT_PUBLIC_DISPLAY_TIMEZONE}
RUN test -n "$APP" && test -n "$CORE" || { echo "build arguments APP and CORE are required" >&2; exit 1; }
WORKDIR /repo
RUN corepack enable
# Every locked package, from the lockfile alone: this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY packages/config packages/config
COPY packages/core packages/core
COPY packages/${CORE} packages/${CORE}
COPY packages/ui packages/ui
COPY packages/web-kit packages/web-kit
COPY apps/${APP} apps/${APP}
RUN pnpm install --offline --frozen-lockfile --filter "@mb/${APP}..."
RUN pnpm --filter "@mb/${APP}" build

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ARG APP
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The standalone server keeps the repo's layout (apps/<app>/server.js beside the traced packages);
# the static files and public/ aren't in the trace and go next to it.
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=build --chown=node:node /repo/apps/${APP}/public ./apps/${APP}/public
WORKDIR /app/apps/${APP}
USER node
EXPOSE 3000
# robots.txt needs neither the database nor the engine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM, so Next closes its connections on a stop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
