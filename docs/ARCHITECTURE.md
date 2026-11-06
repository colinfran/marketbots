# Architecture

The platform view of marketbots: how the two bots run side by side, what the repo holds, what the bots share, and what stays per bot by design. Each bot's own design (trading loop, risk model, news engine, data model) is in [CRYPTO.md](CRYPTO.md) and [STOCK.md](STOCK.md). Running the stack is in [SERVER.md](SERVER.md).

## Two bots, one repo

| | CryptoMarketBot | StockMarketBot |
| --- | --- | --- |
| Trades | Kraken spot pairs, 24/7, in a Kraken CLI paper wallet | US stocks and defined-risk options on market days, in an Alpaca paper account |
| Engine | `apps/crypto-engine` → container `marketbots-crypto-engine`, 127.0.0.1:8787 | `apps/stock-engine` → container `marketbots-stock-engine`, 127.0.0.1:8788 |
| Dashboard | `apps/crypto-web` → Vercel, cryptomarketbot.app | `apps/stock-web` → Vercel, stockmarketbot.app |
| Live stream | `wss://engine.cryptomarketbot.app/v1/stream` | `wss://engine.stockmarketbot.app/v1/stream` |
| Database (Azure DocumentDB) | `cryptomarketbot` | `stockmarketbot` |
| Config | `.env`: SHARED and `CRYPTO_*` | `.env`: SHARED and `STOCK_*` |
| Design doc | [CRYPTO.md](CRYPTO.md) | [STOCK.md](STOCK.md) |

The rules behind the layout:

- **Two independent engines.** Separate images, containers, processes, ports, databases, leases and variables (each gets only its own from `.env`). They share library code, compiled into each image at build time, and have no runtime link to each other. A crash, deploy or restart of one never touches the other.
- **Two dashboards with separate auth.** Each has its own auth secret, database, domain and owner check.
- **Share code only when both bots mean the same thing by it.** If sharing would need flags that switch between two behaviors, or would bend one bot's model to fit the other's, the code stays per bot.
- **Paper trading only.** Neither engine has a live-trading code path.

## Runtime topology

```
Browser ──https──▶ Vercel: cryptomarketbot.app, stockmarketbot.app ──▶ Azure DocumentDB
   │                                                                              ▲
   └── wss://engine.<domain>/v1/stream ──▶ Caddy (Windows host)                   │
                                             ├─▶ 127.0.0.1:8787  crypto-engine ───┤
                                             ├─▶ 127.0.0.1:8788  stock-engine  ───┘
Vercel (Admin → Server) ── https://engine.<domain>/host ──┴─▶ 127.0.0.1:8789  host agent (its readings in a local SQLite file)
                     marketbots stack:  crypto-engine, stock-engine ──▶ scraper (Playwright), no host port
                                                                    ──▶ search (SearXNG, local research), no host port
                                                                    ──▶ llm (llama.cpp, Qwen 3.6, both GPUs),
                                                                    ──▶ history (Postgres + TimescaleDB + pgvector),
                                                                        both on network `ai`: no host port, no internet
Windows host, outside Docker: host agent (+ LibreHardwareMonitor, nvidia-smi, the VeSync outlet)
External: Kraken (CLI wallet in its volume), Alpaca, ~150 news sources, and the search engines behind `search`
```

- **Each engine owns its bot's trading state.** It is the only writer of positions, orders and fills, and a MongoDB lease in its own database guarantees one running instance per bot.
- **The dashboards never trade.** They read MongoDB, read the engine's heartbeat from the engine itself (its signed `GET /v1/status`; it isn't stored), send the owner's commands straight to the engine (signed with the stream secret; refused, never queued, while the engine can't be reached), and write only audit entries and sign-in records.
- **The engines listen only on loopback**: the read-only live stream, `/healthz` and `/readyz`, and the command endpoints, which answer only requests signed with the stream secret. Caddy on the host terminates TLS and forwards each `engine.<domain>` to its port. Ports, Caddy sites and domains are the same as before the merge.
- **The host agent reads the machine itself** ([SERVER.md §11](SERVER.md#11-the-host-agent-admin--server)): a Node process on Windows, not in Docker (containers see only the Docker VM). It keeps the hardware readings on the server (a SQLite file) and serves them, with the owner's fan and settings commands, through a small API on loopback that Caddy publishes at `/host` on each engine domain. The dashboards' servers call it with a shared secret only while Admin → Server is open, so nothing about the machine goes to the database. It also runs the motherboard fans.

### What the bots share at runtime

| Shared | How |
| --- | --- |
| Scraper | One container, `http://scraper:8790` on the compose network. Three renders at a time; each caller (the `X-Client` header, else the engine container's address) may hold at most 8 of the 16 queue places, so one bot can't starve the other. If it dies, only the headless news sources go down. |
| Local model | One llama.cpp server on both GPUs (`llm`, Qwen 3.6 35B-A3B at 2-bit) on the internal `ai` network, `http://llm:8080` (OpenAI-compatible), with a slot per bot and one for news. It runs every AI call of both engines: the agents' episodes, their research and the article summaries. If it is down, the engines still protect positions but make no new decisions ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)). |
| Search service | One SearXNG container, `http://search:8080` on the compose network, that runs the web searches of the agents' research tool (`@mb/wire/research`) for both engines, on free search engines only. If it is down, research fails and the agent decides without it. |
| History store | One Postgres container (TimescaleDB, pgvector) on the internal `ai` network, with a database and a role per bot (`crypto_history`, `stock_history`): each engine's `HISTORY_URL` holds only its own password. Each engine writes its closed 1-minute bars and archives its news there (`@mb/history`, [plans/LOCAL-AI.md §6](plans/LOCAL-AI.md#6-the-history-store-history)). If it is down, only history stops. |
| Database cluster (Azure DocumentDB) | One cluster, a separate database per bot. |
| Host agent | One process on Windows ([SERVER.md §11](SERVER.md#11-the-host-agent-admin--server)) keeps one copy of the machine's readings, which both dashboards fetch from its API, and either dashboard can send it commands. If it is down, only Admin → Server goes offline (and the BIOS runs the fans). |
| The server's IP | Outbound rate limits (SEC, GDELT, ForexFactory…) apply to both bots together. |
| Caddy | One host process, one site per engine; each site also forwards `/host` to the host agent. |

Not shared: databases (MongoDB and history), leases, the bots' own variables (`CRYPTO_*`, `STOCK_*`), auth secrets, stream token secrets (whose HMAC context prefixes, `cmb-stream.` and `smb-stream.`, also keep tokens from crossing bots), and the Kraken wallet volume (crypto only).

## Repo layout

```
marketbots/
├─ apps/
│  ├─ crypto-engine/   @mb/crypto-engine   (was cryptomarketbot/apps/engine)
│  ├─ crypto-web/      @mb/crypto-web      (was cryptomarketbot/apps/web)      → Vercel (crypto)
│  ├─ stock-engine/    @mb/stock-engine    (was stockmarketbot/apps/engine)
│  ├─ stock-web/       @mb/stock-web       (was stockmarketbot/apps/web)       → Vercel (stock)
│  ├─ host-agent/      @mb/host-agent      the Windows host agent (Admin → Server, the fans); the server's own Node, not Docker
│  └─ scraper/         @mb/scraper         one sidecar; own npm lockfile, outside the pnpm workspace
├─ packages/
│  ├─ config/          @mb/config          tsconfig base, ESLint presets with the import boundaries, Vitest presets, mb-env
│  ├─ core/            @mb/core            pure shared schemas and helpers
│  ├─ engine-kit/      @mb/engine-kit      engine runtime
│  ├─ history/         @mb/history         the history store: Postgres client, migrations, bars, news archive
│  ├─ agent/           @mb/agent           the agent runtime: attention queue, episodes, tools, watches, breakers
│  ├─ wire/            @mb/wire            the news engine
│  ├─ ui/              @mb/ui              client-safe React
│  ├─ web-kit/         @mb/web-kit         server-only dashboard helpers
│  ├─ crypto-core/     @mb/crypto-core     crypto schemas (was cryptomarketbot/packages/core)
│  └─ stock-core/      @mb/stock-core      stock schemas (was stockmarketbot/packages/core)
├─ contracts/          behavior snapshots per bot (contracts/<bot>/)
├─ docs/               ARCHITECTURE.md (this file), CRYPTO.md, STOCK.md, SERVER.md
├─ compose.yml         the marketbots stack
├─ compose.smoke.yml   boot test of new images beside the live stack
├─ .env.example       every variable of the stack, in sections (copy to .env)
├─ AGENTS.md           conventions for changing this repo
└─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml
```

## Shared code

Both bots were moved in from their old repos unchanged and then refactored onto the shared packages below. No file is mirrored by hand any more. Code that still exists once per bot does so on purpose (see [What stays per bot](#what-stays-per-bot-by-design)).

| Package | Holds | Used by |
| --- | --- | --- |
| `@mb/core` | Pure shared schemas and helpers, no I/O: `math`, `stream-token` (prefix as a parameter), settings base pieces and helpers, the shared command schemas, the event envelope and the events both bots define identically, base collections, indexes and document types, wire types, `metrics`, `indicators`, generic `time`, and `host`: the host agent's documents, settings, fan rules, commands and chart ranges | every app and package |
| `@mb/engine-kit` | Engine runtime, generic over each bot's settings, events and commands: log, lease, heartbeat, bus, stream server, command processor, Mongo connect, state stores, alerts, the AI call log and prompt parts, the live model feed (`ai/monitor`: every model call's thinking and output, streamed once a second; `ai/model-server`: the server's slots), `ControlPlane`, `StatusReporter`, bootstrap, env base, test helpers | both engines |
| `@mb/wire` | The news engine: the formerly mirrored files, shared source helpers, `sharedCatalog()`, a `makeLexicon()` skeleton, `enrich/` for article summaries, and `research/` for local research (web search, with the metered search APIs paced through the month, then the local model) | both engines |
| `@mb/history` | The history store ([plans/LOCAL-AI.md §6](plans/LOCAL-AI.md#6-the-history-store-history)): the Postgres client (node-postgres; PGlite in tests), the migrations, the 1-minute bar writer, the news archive (wire items and triggers copied from MongoDB before their TTL), the moves after each news item, the job runner the backfills use, `HistoryStore`. `docker/initdb.sh` creates each bot's database and role | both engines |
| `@mb/agent` | The agent runtime ([plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent)), generic over each bot's tools, brief and answer: the attention queue, the episode loop and its llama.cpp client, the tool registry and the tools both bots share (news, the dossier, an item, the calendar, history, past news, and web research on one question for P2/P3 episodes), watches and notes, the envelope (rate limits only) and the circuit breakers (pure functions, for extreme cases: a 20% drawdown from the peak pauses new entries until the owner resumes them; a slow model or a run of invalid answers pauses them while it lasts; exits continue), the observations both bots make (news, and `newsWoke`: the only time the agent may close a trend-core position), the journal, `Agent`. Each bot's `src/agent/` trades the paper account through the bot's own execution path, beside the bot's rule-based trend core (since 2026-11-06), and there are no timed cycles. The types and settings both bots share are in `@mb/core/agent` and `@mb/core/settings` | both engines |
| `@mb/ui` | Client-safe React: the shadcn primitives, design tokens (`styles.css`, with the three categorical chart colors), app-shell components (including the navigation, below), the live-UI shell driven by a per-bot event catalog, shared page sections (the Agent page's: `agent`, `agent-events`; Admin → Server's: `host`), the charts (`@mb/ui/charts`) | both dashboards |
| `@mb/web-kit` | Server-only dashboard helpers: auth factory, database, signed calls to the engine (`engine-link`) and its heartbeat (`engine-status`), command routes, shared queries (the agent's in `agent`; Admin → Server's queries, routes and host commands in `host`; Admin → System's database storage in `storage`, with Azure Monitor's count in `azure`), formatting, metadata, error reporting | both dashboards |

### The dashboards' navigation

Both dashboards have the same pages under the same URLs, in five sections (`packages/ui/src/site-header.tsx`). The header links to each section; a section with more than one page lists them in a second row.

| Section | Pages |
| --- | --- |
| Live | `/`: the account at a glance, the model's live feed, the engine card and the activity feed |
| Agent | `/agent`: the model's live feed (every call's thinking and answer as it streams, once a second), the agent's episodes as they run, its watches and notes, the owner's questions and "Wake the agent"; `/agent/<id>`: one episode |
| Portfolio | Holdings (with the owner's sell and close buttons), Trades (and on crypto each decision, `/decisions/<id>`) |
| Markets | Markets, News (`/news`: the news engine, its sources and triggers) |
| Performance | Analytics, Journal |
| About | How it works |
| Admin | Owner only. `/admin`: settings (the agent's included, and on crypto the strategy toggles), system health (with the database's storage), the audit log; `/admin/server`: the Windows machine both bots run on, its history and its fans ([SERVER.md §11](SERVER.md#11-the-host-agent-admin--server)) |

The live feed and the agent's events push to the page as they happen (the feed batches a model call's text once a second); everything else refreshes every 2 seconds. The model's thinking is owner-only unless `agent.public_thinking` is on: it quotes untrusted news text.

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
| `host-agent` | `@mb/core` |

No package or app ever imports an app. ESLint enforces this with `no-restricted-imports`, built by `boundaries(owner)` in `packages/config/eslint.mjs`; each package's `eslint.config.mjs` names its owner. How to work with it: [AGENTS.md](../AGENTS.md).

## How packages are consumed

- **As TypeScript source.** A package exports `"./*": "./src/*.ts"` and is imported by subpath (`@mb/crypto-core/settings`). Nothing is built ahead:
  - the engines bundle packages with esbuild (`apps/*-engine/build.mjs` → `dist/main.js`);
  - the dashboards list them in `transpilePackages` (`next.config.ts`);
  - Vitest and `tsc` read the source directly.
- `@mb/config` exports its files as they are (`"./*": "./*"`): `tsconfig.base.json`, `eslint.mjs`, `vitest.mjs`. Its `mb-env` command (`mb-env.mjs`, `env.mjs`) runs the apps' `dev` scripts with one bot's variables from `.env` and `.env.local`.
- **Plain pnpm workspaces**, no Turborepo. The scraper is outside the workspace, with its own npm lockfile and image.

## Builds and deploys

| Part | Built | Deployed |
| --- | --- | --- |
| Engines | A Docker image each, built from the repo root: `pnpm fetch` (lockfile only, cached), an offline install filtered to `@mb/<bot>-engine...`, the esbuild bundle. Runtime: `node:22-bookworm-slim` pinned by digest, tini, non-root, healthcheck. Crypto adds the checksummed Kraken CLI and the `/data/kraken` volume. | `docker compose up -d --build <bot>-engine` on the server |
| Scraper | The official Playwright image plus `playwright-core` | `docker compose up -d --build scraper` |
| History store | The official TimescaleDB image (Postgres 17 with TimescaleDB and pgvector) pinned by digest; no build | `docker compose up -d history history-backup` |
| Dashboards and landing page | Vercel, Root Directory `apps/<bot>-web` (landing: `apps/landing`), files outside the root included | push to `main`; Vercel skips a project when neither its app nor a workspace package it depends on changed |
| Host agent | An esbuild bundle on the server (`apps/host-agent/build.mjs`): the agent, its fan watchdog, the one-off history import | `pnpm --filter @mb/host-agent build`, then restart its scheduled task ([SERVER.md §11.3](SERVER.md#113-deploy-restart-logs)) |

Every deploy is gated by `pnpm typecheck && pnpm test && pnpm lint && pnpm build`. The contract snapshots under `contracts/<bot>/` change only with a deliberate, owner-approved behavior change ([AGENTS.md](../AGENTS.md)).

## Configuration

One env file, `.env` at the repo root, in sections: SHARED (no prefix, the same for both bots), `CRYPTO_*`, `STOCK_*`, `HISTORY_*` (the history store's passwords), SEARCH and HOST. The code reads the names it always used: `compose.yml` gives each container only its own variables, without the bot prefix (`CRYPTO_MONGODB_DB_NAME` is the crypto engine's `MONGODB_DB_NAME`), and sets `STREAM_HOST`, `STREAM_PORT`, `SCRAPER_URL`, `LLM_URL`, `SEARCH_URL` and each engine's `HISTORY_URL`, built from its bot's history password. Local dev renames the same way through `mb-env` (`@mb/config`), reading `.env`, then `.env.local`. Each Vercel project holds its dashboard's values under the unprefixed names. The host agent reads `.env` directly. Details: [SERVER.md §3](SERVER.md#3-the-env-file), [§11.1](SERVER.md#111-its-variables).

Live trading settings are not configuration: they live in each bot's database and change only from its dashboard's Admin page.

## What stays per bot (by design)

| Crypto | Stock |
| --- | --- |
| Kraken CLI wallet, books, ledger, reconciliation, WebSocket book, candles, strategies (the agent's setups), risk engine | Alpaca REST and streams, orders/OCO/brackets, options (menus, entries, exits), sessions, price board and layers, scan universe |
| The agent's prompts, tools and answer | The agent's prompts, tools and answer |
| Wire catalog, lexicon rules, policy rules, domain sources (chain, DefiLlama, derivatives, Korea, hacks…) | Wire catalog, lexicon rules, policy rules, domain sources (EDGAR, halts, FDA, insiders, congress, MarketBeat…) |
| Same-name events with different payloads (`market.ticker`, `order.*`, `position.*`, `risk.checked`…), the bot section of the engine's status, the `decisions` / `daily_stats` shapes | Same |
| Pages: holdings, markets/[pair], decisions/[id], `/api/candles`, decision card, tables, chart wrappers (crypto's data and formats) | Pages: holdings, markets/[symbol], options tab, public JSON API, market status, tables, chart wrappers (stock's data and formats) |

## Reading CRYPTO.md and STOCK.md

Both were copied unchanged from the old repos' `docs/ARCHITECTURE.md`, so their paths use the old layout:

| In CRYPTO.md / STOCK.md | In this repo |
| --- | --- |
| `apps/engine` | `apps/crypto-engine` / `apps/stock-engine` |
| `apps/web` | `apps/crypto-web` / `apps/stock-web` |
| `packages/core`, `@cmb/core`, `@smb/core` | `packages/crypto-core` / `packages/stock-core`, `@mb/crypto-core` / `@mb/stock-core` |
| `apps/scraper`, one per bot | `apps/scraper`, one for both |
| "Mirrored in cryptomarketbot and stockmarketbot" | `packages/wire` (`@mb/wire`), once for both |
| `docker-compose.yml`, `.env` | `compose.yml`, `.env` (in sections, the bot's variables prefixed) |

When a change adds or changes a shared package, update the tables in this file; per-bot behavior goes in CRYPTO.md or STOCK.md.
