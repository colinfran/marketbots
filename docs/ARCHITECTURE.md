# Architecture

The platform view of marketbots: how the two bots run side by side, what the repo holds, what the bots share today and what they will share, and what stays per bot by design. Each bot's own design (trading loop, risk model, news engine, data model) is in [CRYPTO.md](CRYPTO.md) and [STOCK.md](STOCK.md). Running the stack is in [SERVER.md](SERVER.md). The merge plan and its phases are in [plans/MARKETBOTS_PLAN.md](plans/MARKETBOTS_PLAN.md).

## Two bots, one repo

| | CryptoMarketBot | StockMarketBot |
| --- | --- | --- |
| Trades | Kraken spot pairs, 24/7, in a Kraken CLI paper wallet | US stocks and defined-risk options on market days, in an Alpaca paper account |
| Engine | `apps/crypto-engine` → container `marketbots-crypto-engine`, 127.0.0.1:8787 | `apps/stock-engine` → container `marketbots-stock-engine`, 127.0.0.1:8788 |
| Dashboard | `apps/crypto-web` → Vercel, cryptomarketbot.app | `apps/stock-web` → Vercel, stockmarketbot.app |
| Live stream | `wss://engine.cryptomarketbot.app/v1/stream` | `wss://engine.stockmarketbot.app/v1/stream` |
| Database (Atlas) | `cryptomarketbot` | `stockmarketbot` |
| Config | `crypto.env` | `stock.env` |
| Design doc | [CRYPTO.md](CRYPTO.md) | [STOCK.md](STOCK.md) |

The rules behind the layout (plan §1–2):

- **Two independent engines.** Separate images, containers, processes, ports, databases, leases and env files. They share library code, compiled into each image at build time, and have no runtime link to each other. A crash, deploy or restart of one never touches the other.
- **Two dashboards with separate auth.** Each has its own auth secret, database, domain and owner check.
- **Share code only when both bots mean the same thing by it.** If sharing would need flags that switch between two behaviors, or would bend one bot's model to fit the other's, the code stays per bot.
- **Paper trading only.** Neither engine has a live-trading code path.

## Runtime topology

```
Browser ──https──▶ Vercel: cryptomarketbot.app, stockmarketbot.app ──▶ MongoDB Atlas
   │                                                                              ▲
   └── wss://engine.<domain>/v1/stream ──▶ Caddy (Windows host)                   │
                                             ├─▶ 127.0.0.1:8787  crypto-engine ───┤
                                             └─▶ 127.0.0.1:8788  stock-engine  ───┘
                     marketbots stack:  crypto-engine, stock-engine ──▶ scraper (Playwright), no host port
                                                                    ──▶ llm (Ollama, RTX 3070, Phase 10), no host port
External: Kraken (CLI wallet in its volume), Alpaca, Vercel AI Gateway (Grok), ~150 news sources
```

- **Each engine owns its bot's trading state.** It is the only writer of positions, orders and fills, and a MongoDB lease in its own database guarantees one running instance per bot.
- **The dashboards never trade.** They read MongoDB and write only commands (polled by the engine every second), audit entries and sign-in records.
- **The engines listen only on loopback**: the read-only live stream plus `/healthz` and `/readyz`. Caddy on the host terminates TLS and forwards each `engine.<domain>` to its port. Ports, Caddy sites and domains are the same as before the merge.

### What the bots share at runtime

| Shared | How |
| --- | --- |
| Scraper | One container, `http://scraper:8790` on the compose network. Three renders at a time; each caller (the `X-Client` header, else the engine container's address) may hold at most 8 of the 16 queue places, so one bot can't starve the other. If it dies, only the headless news sources go down. |
| Local LLM (Phase 10) | One Ollama container on the GPU, `http://llm:11434`. Off until Phase 10. |
| Atlas cluster | One cluster, a separate database per bot. |
| The server's IP | Outbound rate limits (SEC, GDELT, ForexFactory…) apply to both bots together. |
| Vercel AI Gateway key | Can be the same key; each bot enforces its own daily AI budget. |
| Caddy | One host process, one site per engine. |

Not shared: databases, leases, env files, auth secrets, stream token secrets (whose HMAC context prefixes, `cmb-stream.` and `smb-stream.`, also keep tokens from crossing bots), and the Kraken wallet volume (crypto only).

## Repo layout

Today:

```
marketbots/
├─ apps/
│  ├─ crypto-engine/   @mb/crypto-engine   (was cryptomarketbot/apps/engine)
│  ├─ crypto-web/      @mb/crypto-web      (was cryptomarketbot/apps/web)      → Vercel (crypto)
│  ├─ stock-engine/    @mb/stock-engine    (was stockmarketbot/apps/engine)
│  ├─ stock-web/       @mb/stock-web       (was stockmarketbot/apps/web)       → Vercel (stock)
│  └─ scraper/         @mb/scraper         one sidecar; own npm lockfile, outside the pnpm workspace
├─ packages/
│  ├─ config/          @mb/config          tsconfig base, ESLint presets with the import boundaries, Vitest presets
│  ├─ crypto-core/     @mb/crypto-core     crypto schemas (was cryptomarketbot/packages/core)
│  └─ stock-core/      @mb/stock-core      stock schemas (was stockmarketbot/packages/core)
├─ contracts/          behavior snapshots per bot (contracts/<bot>/)
├─ docs/               ARCHITECTURE.md (this file), CRYPTO.md, STOCK.md, SERVER.md, plans/
├─ compose.yml         the marketbots stack
├─ compose.smoke.yml   boot test of new images beside the live stack
├─ crypto.env.example  stock.env.example
├─ AGENTS.md           conventions for changing this repo
└─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml
```

Phases 5–8 add `packages/core`, `packages/engine-kit`, `packages/wire`, `packages/ui` and `packages/web-kit` (below).

## Shared code: today and planned

**Today the only shared package is `packages/config`.** Both bots were moved in unchanged (Phase 2), so each bot's engine, dashboard and core package are still its own, and the code they have in common still exists twice:

- The 24 news-engine files headed `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.` in `apps/crypto-engine/src/wire/` and `apps/stock-engine/src/wire/`.
- The 18 shadcn primitives in `apps/*-web/components/ui/` (identical; stock also has `chart.tsx`).
- More generally, the plan's comparison (§0) found 33 engine and core files identical apart from the package scope, and 11 more that differ only in a constant.

Until those move into shared packages, a change to one copy is made to the other as well (AGENTS.md).

**Planned packages:**

| Package | Phase | Holds | Used by |
| --- | --- | --- | --- |
| `@mb/core` | 5 | Pure shared schemas and helpers, no I/O: `math`, `stream-token` (prefix as a parameter), settings base pieces and helpers, the shared command schemas, the event envelope and the events both bots define identically, base collections, indexes and document types, wire types, `metrics`, `indicators`, generic `time` | every app and package |
| `@mb/engine-kit` | 6 | Engine runtime, generic over each bot's settings, events and commands: log, lease, heartbeat, bus, stream server, command processor, Mongo connect, state stores, alerts, AI budget/repair/runner/prompt parts, `ControlPlane`, `StatusReporter`, `EventCycleQueue`, bootstrap, env base, test helpers | both engines |
| `@mb/wire` | 7 | The news engine: the mirrored files, shared source helpers, `sharedCatalog()`, a `makeLexicon()` skeleton, and (Phase 10) `enrich/` for article summaries | both engines |
| `@mb/ui` | 8 | Client-safe React: the shadcn primitives, design tokens (`styles.css`), app-shell components, the live-UI shell driven by a per-bot event catalog, shared page sections | both dashboards |
| `@mb/web-kit` | 8 | Server-only dashboard helpers: auth factory, database, command routes, shared queries, formatting, metadata, error reporting | both dashboards |

In Phase 5, `crypto-core` and `stock-core` start extending `@mb/core`, and crypto's AI output schema moves from the engine into `crypto-core`. The full module lists are in plan §3.3. Where the two bots' versions of something differ, plan §3.5 says which version wins and in which phase. Behavior changes are kept out of Phases 5–8 and done one by one in Phase 9.

## Dependency direction

| Package or app | May import (besides itself and `@mb/config`) |
| --- | --- |
| `@mb/core` | no other `@mb` package |
| `@mb/engine-kit` | `@mb/core` |
| `@mb/wire` | `@mb/core`, `@mb/engine-kit` |
| `@mb/ui`, `@mb/web-kit` | `@mb/core` |
| `crypto-core`, `crypto-engine`, `crypto-web` | shared packages and crypto packages; never a stock package |
| `stock-core`, `stock-engine`, `stock-web` | shared packages and stock packages; never a crypto package |

No package or app ever imports an app. ESLint enforces this with `no-restricted-imports`, built by `boundaries(owner)` in `packages/config/eslint.mjs`; each package's `eslint.config.mjs` names its owner. How to work with it: [AGENTS.md](../AGENTS.md).

## How packages are consumed

- **As TypeScript source.** A package exports `"./*": "./src/*.ts"` and is imported by subpath (`@mb/crypto-core/settings`). Nothing is built ahead:
  - the engines bundle packages with esbuild (`apps/*-engine/build.mjs` → `dist/main.js`);
  - the dashboards list them in `transpilePackages` (`next.config.ts`);
  - Vitest and `tsc` read the source directly.
- `@mb/config` exports its files as they are (`"./*": "./*"`): `tsconfig.base.json`, `eslint.mjs`, `vitest.mjs`.
- **Plain pnpm workspaces**, no Turborepo. The scraper is outside the workspace, with its own npm lockfile and image.

## Builds and deploys

| Part | Built | Deployed |
| --- | --- | --- |
| Engines | A Docker image each, built from the repo root: `pnpm fetch` (lockfile only, cached), an offline install filtered to `@mb/<bot>-engine...`, the esbuild bundle. Runtime: `node:22-bookworm-slim` pinned by digest, tini, non-root, healthcheck. Crypto adds the checksummed Kraken CLI and the `/data/kraken` volume. | `docker compose up -d --build <bot>-engine` on the server |
| Scraper | The official Playwright image plus `playwright-core` | `docker compose up -d --build scraper` |
| Dashboards | Vercel, Root Directory `apps/<bot>-web`, files outside the root included | push to `main`; an Ignored Build Step skips a dashboard none of whose paths changed |

Every deploy is gated by `pnpm typecheck && pnpm test && pnpm lint && pnpm build`. The refactor phases (5–8) are also gated by unchanged contract snapshots under `contracts/<bot>/` and test counts at or above the baseline (plan §8).

## Configuration

One env file per bot at the repo root, `crypto.env` and `stock.env`, under the variable names the code already used. The engine container reads its file through compose, which also sets `STREAM_HOST`, `STREAM_PORT`, `SCRAPER_URL` and `LLM_URL`. Local dev reads the same file, then `<bot>.local.env`. The file's SHARED and DASHBOARD sections are what goes into the bot's Vercel project. Details: [SERVER.md §3](SERVER.md#3-the-env-files).

Live trading settings are not configuration: they live in each bot's database and change only from its dashboard's Admin page.

## What stays per bot (by design)

| Crypto | Stock |
| --- | --- |
| Kraken CLI wallet, books, ledger, reconciliation, WebSocket book, candles, backtester, strategies, risk engine | Alpaca REST and streams, orders/OCO/brackets, options (menus, entries, exits), scheduler and sessions, price board and layers, scan universe |
| Prompts and the AI output schema | Prompts and the report schema |
| Wire catalog, lexicon rules, policy rules, domain sources (chain, DefiLlama, derivatives, Korea, hacks…) | Wire catalog, lexicon rules, policy rules, domain sources (EDGAR, halts, FDA, insiders, congress, MarketBeat…) |
| Same-name events with different payloads (`market.ticker`, `cycle.*`, `order.*`, `position.*`, `risk.checked`…), the bot section of `engine_status`, the `cycles` / `decisions` / `daily_stats` shapes | Same |
| Pages: dashboard, holdings, markets/[pair], decisions/[id], strategies and backtests, `/api/candles`, decision card, tables, charts (until Phase 9), `buildTrail` | Pages: dashboard, holdings, markets/[symbol], research/[id] report, options tab, public JSON API, report view, market status, tables, charts (until Phase 9), `buildTrail` |

## Reading CRYPTO.md and STOCK.md

Both were copied unchanged from the old repos' `docs/ARCHITECTURE.md`, so their paths use the old layout:

| In CRYPTO.md / STOCK.md | In this repo |
| --- | --- |
| `apps/engine` | `apps/crypto-engine` / `apps/stock-engine` |
| `apps/web` | `apps/crypto-web` / `apps/stock-web` |
| `packages/core`, `@cmb/core`, `@smb/core` | `packages/crypto-core` / `packages/stock-core`, `@mb/crypto-core` / `@mb/stock-core` |
| `apps/scraper`, one per bot | `apps/scraper`, one for both |
| "Mirrored in cryptomarketbot and stockmarketbot" | mirrored between `apps/crypto-engine` and `apps/stock-engine` until Phase 7 |
| `docker-compose.yml`, `.env` | `compose.yml`, `crypto.env` / `stock.env` |
| `MASTER_PLAN.md` | `docs/plans/MASTER_PLAN.md` |

When a phase adds or changes a shared package, update the tables in this file; per-bot behavior goes in CRYPTO.md or STOCK.md.
