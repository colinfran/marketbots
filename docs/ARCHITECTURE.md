# Architecture

The platform view of marketbots: how the two bots run side by side, what the repo holds, what the bots share, and what stays per bot by design. Each bot's own design (trading loop, risk model, news engine, data model) is in [CRYPTO.md](CRYPTO.md) and [STOCK.md](STOCK.md). Running the stack is in [SERVER.md](SERVER.md).

## Two bots, one repo

| | CryptoMarketBot | StockMarketBot |
| --- | --- | --- |
| Trades | Kraken spot pairs, 24/7, in a Kraken CLI paper wallet | US stocks and defined-risk options on market days, in an Alpaca paper account |
| Engine | `apps/crypto-engine` → container `marketbots-crypto-engine`, 127.0.0.1:8787 | `apps/stock-engine` → container `marketbots-stock-engine`, 127.0.0.1:8788 |
| Dashboard | `apps/crypto-web` → Vercel, cryptomarketbot.app | `apps/stock-web` → Vercel, stockmarketbot.app |
| Live stream | `wss://engine.cryptomarketbot.app/v1/stream` | `wss://engine.stockmarketbot.app/v1/stream` |
| Database (Atlas) | `cryptomarketbot` | `stockmarketbot` |
| Config | `.env.crypto` | `.env.stock` |
| Design doc | [CRYPTO.md](CRYPTO.md) | [STOCK.md](STOCK.md) |

The rules behind the layout:

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
                                                                    ──▶ search (SearXNG, local research), no host port
                                                                    ──▶ llm (llama.cpp, Qwen 3.6, both GPUs),
                                                                    ──▶ history (Postgres + TimescaleDB + pgvector),
                                                                        both on network `ai`: no host port, no internet
External: Kraken (CLI wallet in its volume), Alpaca, ~150 news sources, and the search engines behind `search`
```

- **Each engine owns its bot's trading state.** It is the only writer of positions, orders and fills, and a MongoDB lease in its own database guarantees one running instance per bot.
- **The dashboards never trade.** They read MongoDB and write only commands (polled by the engine every second), audit entries and sign-in records.
- **The engines listen only on loopback**: the read-only live stream plus `/healthz` and `/readyz`. Caddy on the host terminates TLS and forwards each `engine.<domain>` to its port. Ports, Caddy sites and domains are the same as before the merge.

### What the bots share at runtime

| Shared | How |
| --- | --- |
| Scraper | One container, `http://scraper:8790` on the compose network. Three renders at a time; each caller (the `X-Client` header, else the engine container's address) may hold at most 8 of the 16 queue places, so one bot can't starve the other. If it dies, only the headless news sources go down. |
| Local model | One llama.cpp server on both GPUs (`llm`, Qwen 3.6 35B-A3B at 2-bit) on the internal `ai` network, `http://llm:8080` (OpenAI-compatible), with a slot per bot and one for news. It runs every AI call of both engines: research, decisions and article summaries. If it is down, the engines still protect positions but make no new decisions ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)). |
| Search service | One SearXNG container, `http://search:8080` on the compose network, that runs the web searches of research (`@mb/wire/research`) for both engines. If it is down, research fails and cycles decide without it. |
| History store | One Postgres container (TimescaleDB, pgvector) on the internal `ai` network, with a database and a role per bot (`crypto_history`, `stock_history`): each engine's `HISTORY_URL` holds only its own password. Each engine writes its closed 1-minute bars and archives its news there (`@mb/history`, [plans/LOCAL-AI.md §6](plans/LOCAL-AI.md#6-the-history-store-history)). If it is down, only history stops. |
| Atlas cluster | One cluster, a separate database per bot. |
| The server's IP | Outbound rate limits (SEC, GDELT, ForexFactory…) apply to both bots together. |
| Caddy | One host process, one site per engine. |

Not shared: databases (Atlas and history), leases, env files, auth secrets, stream token secrets (whose HMAC context prefixes, `cmb-stream.` and `smb-stream.`, also keep tokens from crossing bots), and the Kraken wallet volume (crypto only).

## Repo layout

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
│  ├─ core/            @mb/core            pure shared schemas and helpers
│  ├─ engine-kit/      @mb/engine-kit      engine runtime
│  ├─ history/         @mb/history         the history store: Postgres client, migrations, bars, news archive
│  ├─ agent/           @mb/agent           the agent runtime: attention queue, episodes, watches, shadow book
│  ├─ wire/            @mb/wire            the news engine
│  ├─ ui/              @mb/ui              client-safe React
│  ├─ web-kit/         @mb/web-kit         server-only dashboard helpers
│  ├─ crypto-core/     @mb/crypto-core     crypto schemas (was cryptomarketbot/packages/core)
│  └─ stock-core/      @mb/stock-core      stock schemas (was stockmarketbot/packages/core)
├─ contracts/          behavior snapshots per bot (contracts/<bot>/)
├─ docs/               ARCHITECTURE.md (this file), CRYPTO.md, STOCK.md, SERVER.md
├─ compose.yml         the marketbots stack
├─ compose.smoke.yml   boot test of new images beside the live stack
├─ .env.crypto.example  .env.stock.example
├─ AGENTS.md           conventions for changing this repo
└─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml
```

## Shared code

Both bots were moved in from their old repos unchanged and then refactored onto the shared packages below. No file is mirrored by hand any more. Code that still exists once per bot does so on purpose (see [What stays per bot](#what-stays-per-bot-by-design)).

| Package | Holds | Used by |
| --- | --- | --- |
| `@mb/core` | Pure shared schemas and helpers, no I/O: `math`, `stream-token` (prefix as a parameter), settings base pieces and helpers, the shared command schemas, the event envelope and the events both bots define identically, base collections, indexes and document types, wire types, `metrics`, `indicators`, generic `time` | every app and package |
| `@mb/engine-kit` | Engine runtime, generic over each bot's settings, events and commands: log, lease, heartbeat, bus, stream server, command processor, Mongo connect, state stores, alerts, AI call log/repair/runner (the local model server)/prompt parts, `ControlPlane`, `StatusReporter`, `EventCycleQueue`, bootstrap, env base, test helpers | both engines |
| `@mb/wire` | The news engine: the formerly mirrored files, shared source helpers, `sharedCatalog()`, a `makeLexicon()` skeleton, `enrich/` for article summaries, and `research/` for local research (web search, then the local model) | both engines |
| `@mb/history` | The history store ([plans/LOCAL-AI.md §6](plans/LOCAL-AI.md#6-the-history-store-history)): the Postgres client (node-postgres; PGlite in tests), the migrations, the 1-minute bar writer, the news archive (wire items and triggers copied from MongoDB before their TTL), the moves after each news item, the job runner the backfills use, `HistoryStore`. `docker/initdb.sh` creates each bot's database and role | both engines |
| `@mb/agent` | The agent runtime ([plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent)), generic over each bot's tools, brief and answer: the attention queue, the episode loop and its llama.cpp client, the tool registry and the tools both bots share (news, the dossier, an item, the calendar, history, past news), watches and notes, the envelope and circuit breakers (pure functions), the shadow book, the journal, `Agent`. The types and settings both bots share are in `@mb/core/agent` and `@mb/core/settings` | both engines |
| `@mb/ui` | Client-safe React: the shadcn primitives, design tokens (`styles.css`), app-shell components (including the navigation, below), the live-UI shell driven by a per-bot event catalog, shared page sections, the charts (`@mb/ui/charts`) | both dashboards |
| `@mb/web-kit` | Server-only dashboard helpers: auth factory, database, command routes, shared queries, formatting, metadata, error reporting | both dashboards |

### The dashboards' navigation

Both dashboards have the same pages under the same URLs, in five sections (`packages/ui/src/site-header.tsx`). The header links to each section; a section with more than one page lists them in a second row.

| Section | Pages |
| --- | --- |
| Live | `/`: the account at a glance, the latest cycle as it runs, the engine card and the activity feed |
| Portfolio | Holdings (with the owner's sell and close buttons), Trades, and on stock the Core book (`/core`) |
| Research | AI research (`/research`: cycles or reports, and decisions), News (`/news`: the news engine, its sources and triggers), Markets |
| Performance | Analytics, Strategies (each strategy's or setup's results beside why it should work), Journal |
| About | How it works |
| Admin | Owner only |

Each piece of information has one page; others link to it. The equity and daily P&L charts are only on Analytics, and the news sources only on News (with their errors when the owner is signed in; Admin → System has a one-line summary).

`crypto-core` and `stock-core` build on `@mb/core`: the shared logic lives there once, and each bot core binds its own parameters (the stream-token prefix, its wire categories, its owner-only events, its settings sections). Crypto's AI output schema lives in `crypto-core/src/report.ts`.

## Dependency direction

| Package or app | May import (besides itself and `@mb/config`) |
| --- | --- |
| `@mb/core` | no other `@mb` package |
| `@mb/engine-kit` | `@mb/core` |
| `@mb/wire` | `@mb/core`, `@mb/engine-kit` |
| `@mb/history` | `@mb/core`, `@mb/engine-kit` |
| `@mb/agent` | `@mb/core`, `@mb/engine-kit`, `@mb/wire` |
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
| History store | The official TimescaleDB image (Postgres 17 with TimescaleDB and pgvector) pinned by digest; no build | `docker compose up -d history history-backup` |
| Dashboards | Vercel, Root Directory `apps/<bot>-web`, files outside the root included | push to `main`; an Ignored Build Step skips a dashboard none of whose paths changed |

Every deploy is gated by `pnpm typecheck && pnpm test && pnpm lint && pnpm build`. The contract snapshots under `contracts/<bot>/` change only with a deliberate, owner-approved behavior change ([AGENTS.md](../AGENTS.md)).

## Configuration

One env file per bot at the repo root, `.env.crypto` and `.env.stock`, under the variable names the code already used. The engine container reads its file through compose, which also sets `STREAM_HOST`, `STREAM_PORT`, `SCRAPER_URL` and `LLM_URL`. Local dev reads the same file, then `.env.<bot>.local`. The file's SHARED and DASHBOARD sections are what goes into the bot's Vercel project. A third file, `.env.history`, holds only the history service's passwords; each bot's file carries its own in `HISTORY_URL`. Details: [SERVER.md §3](SERVER.md#3-the-env-files).

Live trading settings are not configuration: they live in each bot's database and change only from its dashboard's Admin page.

## What stays per bot (by design)

| Crypto | Stock |
| --- | --- |
| Kraken CLI wallet, books, ledger, reconciliation, WebSocket book, candles, backtester, strategies, risk engine | Alpaca REST and streams, orders/OCO/brackets, options (menus, entries, exits), scheduler and sessions, price board and layers, scan universe |
| Prompts and the AI output schema | Prompts and the report schema |
| Wire catalog, lexicon rules, policy rules, domain sources (chain, DefiLlama, derivatives, Korea, hacks…) | Wire catalog, lexicon rules, policy rules, domain sources (EDGAR, halts, FDA, insiders, congress, MarketBeat…) |
| Same-name events with different payloads (`market.ticker`, `cycle.*`, `order.*`, `position.*`, `risk.checked`…), the bot section of `engine_status`, the `cycles` / `decisions` / `daily_stats` shapes | Same |
| Pages: Live (`/`), holdings, markets/[pair], decisions/[id], strategies and backtests, `/api/candles`, decision card, tables, chart wrappers (crypto's data and formats), `buildTrail` | Pages: Live (`/`), holdings, core book, markets/[symbol], research/[id] report, options tab, public JSON API, report view, market status, tables, chart wrappers (stock's data and formats), `buildTrail` |

## Reading CRYPTO.md and STOCK.md

Both were copied unchanged from the old repos' `docs/ARCHITECTURE.md`, so their paths use the old layout:

| In CRYPTO.md / STOCK.md | In this repo |
| --- | --- |
| `apps/engine` | `apps/crypto-engine` / `apps/stock-engine` |
| `apps/web` | `apps/crypto-web` / `apps/stock-web` |
| `packages/core`, `@cmb/core`, `@smb/core` | `packages/crypto-core` / `packages/stock-core`, `@mb/crypto-core` / `@mb/stock-core` |
| `apps/scraper`, one per bot | `apps/scraper`, one for both |
| "Mirrored in cryptomarketbot and stockmarketbot" | `packages/wire` (`@mb/wire`), once for both |
| `docker-compose.yml`, `.env` | `compose.yml`, `.env.crypto` / `.env.stock` |

When a change adds or changes a shared package, update the tables in this file; per-bot behavior goes in CRYPTO.md or STOCK.md.
