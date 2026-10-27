# syntax=docker/dockerfile:1.7
#
# Headless scraper sidecar (page renders and POST /extract), shared by both engines.
# Build from the repository root:
#   docker compose build scraper
#   docker build -f apps/scraper/Dockerfile .
#
# The official Playwright image ships Chromium and its system libraries; playwright-core (same
# version, no dependencies of its own) drives it. Keep the image tag and package.json in step.
# The scraper is outside the pnpm workspace (pnpm-workspace.yaml), with its own npm lockfile.

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp
COPY apps/scraper/package.json apps/scraper/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/scraper/server.mjs apps/scraper/extract.mjs apps/scraper/robots.mjs ./
USER pwuser
EXPOSE 8790
# Some news sites (Yahoo Finance) send ~33 KB of response headers; Node's fetch refuses more than 16 KB by default.
CMD ["node", "--max-http-header-size=65536", "server.mjs"]
