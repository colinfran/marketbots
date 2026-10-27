# Marketbots plan: one repo, two bots, one Docker stack

> Written 2026-10-26 for owner review. Revised the same day: the owner dropped the local database and the move off Vercel, so **MongoDB Atlas and both Vercel dashboards stay as they are**. **Status: Phases 0–2 done (2.5 deferred to after the swap); Phases 3–4 done for the engines (2026-10-26 23:47 PT): both run in the `marketbots` stack. Waiting on the owner: 1.6 (GitHub repo), 4.2 (Vercel re-link), 4.4 (archive the old repos).** This copy (`marketbots/docs/plans/MARKETBOTS_PLAN.md`) is the one to tick; the draft in the cryptomarketbot working tree is superseded.
>
> Sources: both repos at `cryptomarketbot@35319cc` and `stockmarketbot@a0a18f2` (full file-by-file comparison of `apps/web`, `apps/engine`, `packages/core`), both `docs/ARCHITECTURE.md`, `MASTER_PLAN.md`, the running server (`docker ps`/`stats`, `C:\Caddy\Caddyfile`, hardware).

---

## 0. Summary

Merge `cryptomarketbot` and `stockmarketbot` into one pnpm monorepo, `C:\Users\colin\Documents\GitHub\marketbots`. Both bots keep their own engine, dashboard, login and database. Everything the two bots have in common moves into shared packages. One Docker stack named `marketbots` runs both engines, one shared scraper and one small local LLM.

| | Today | After |
|---|---|---|
| Repos | 2, with ~45 hand-mirrored engine files and identical UI kits | 1 repo. Shared code exists once, in `packages/*`; nothing is mirrored by hand |
| Engines | 2 containers in 2 compose projects | Still **2 engines**, each its own image, container, process, port, database, lease and env file. They share library code, compiled into each image at build time, and have **no runtime link** to each other |
| Dashboards | 2 Next.js apps on Vercel | **Unchanged:** the same 2 Vercel projects, domains, logins and secrets, re-linked to the new repo |
| Database | MongoDB Atlas | **Unchanged** |
| Docker | 2 compose projects (engine + scraper each) | 1 stack `marketbots`: crypto engine, stock engine, one scraper, local LLM |
| Scraper | 2 identical Playwright sidecars (both idle: no source uses `headless` yet) | 1 shared scraper. It also extracts article text for summaries |
| Article summaries | none | Llama 3.2 3B on the RTX 3070 through Ollama. It summarizes the article behind each important news item. GPU only, unloads when idle, hard memory caps |
| Config | `.env` per repo; Vercel env vars | `crypto.env` and `stock.env` at the repo root. Each holds everything its bot's engine and dashboard read. The engine container reads its file, local dev of both apps reads it, and its dashboard section is what goes into Vercel |

**What the comparison found**
- The 18 shadcn UI files are **byte-identical** in both apps (the large diffs were CRLF noise in crypto's working tree).
- Every dependency version matches, except the chart library (crypto `lightweight-charts`, stock `recharts`).
- 33 engine/core files are identical apart from the `@cmb`/`@smb` scope, and 11 more differ only in a constant.
- Stock has the better versions of `alerts.ts`, `ai/runner.ts` and the event-cycle queue. Crypto has the better indicator library and performance metrics (`core/metrics.ts`).

---

## 1. Goals and non-goals

**Goals**
1. **One repo, maximum honest sharing.** Code is shared when both bots mean the same thing by it. If sharing would need flags that switch between two different behaviors, or would bend one bot's model to fit the other's, the code stays per bot. (Example: `market.ticker` has a different payload in each bot, so it stays per bot.)
2. **Two independent engines**: separate traffic, logic, failure and deploys. A crash, deploy or restart of one engine never touches the other.
3. **Two separate dashboards with separate auth**, still on Vercel.
4. **One `marketbots` Docker stack**: crypto engine, stock engine, one shared scraper, the local LLM.
5. **Local summaries of the pages behind important news**, fast and light on a shared home PC.

**Non-goals**
- Moving the database or the dashboards (owner, 2026-10-26: Atlas and Vercel stay).
- Changing trading logic, risk limits, prompts or live settings during the move. Behavior changes are listed explicitly and done as their own steps (Phase 9).
- Merging the two engines' domain models (Kraken pairs vs. Alpaca stocks and options).

---

## 2. Rules for this work

1. **Move first, refactor second.** Phase 2 copies both bots in unchanged. Phases 3–4 put that unchanged code into the new stack and swap containers. Sharing (Phases 5–8) happens afterwards in the new repo, one deployable step at a time. The old repos are frozen only from Phase 2 to the swap.
2. **Refactors preserve behavior, and that is proven, not assumed.** Phase 2 commits **contract snapshots** of today's behavior (§4, task 2.5): default settings, settings/command JSON schemas, `INDEXES`, the wire catalog, rendered prompts for fixed contexts, and parsed source fixtures. Phases 5–8 must leave every snapshot byte-identical and keep test counts at or above the baseline. A snapshot diff means a behavior change: stop, then either revert or move the change to Phase 9 with a reason.
3. **Never run two engines against the same broker state.** Old and new engines use the same Atlas database, so the lease stops a second engine from trading, and the shared port (8787/8788) stops it from even starting. The runbook still stops the old container first. Staging boots use a separate `<bot>_staging` database, a **copy** of the wallet volume, and **never** the live Alpaca keys.
4. **Live settings change only from Admin** (unchanged, `MASTER_PLAN.md` §0). Staging databases are throwaway, so scripts may lower their AI budget.
5. **Line endings:** files are copied with `git archive HEAD` (LF, tracked files only), never from crypto's CRLF working tree. The new repo keeps `.gitattributes * text=auto eol=lf` and sets `core.autocrlf=false` locally.
6. **Dependency direction**, enforced by an ESLint `no-restricted-imports` rule:
   - `@mb/core` ← `@mb/crypto-core` / `@mb/stock-core`
   - `@mb/core` ← `@mb/engine-kit` ← `@mb/wire`
   - `@mb/core` ← `@mb/ui`, `@mb/web-kit`
   - Apps depend on packages; packages never import apps.
   - **No crypto package or app ever imports a stock one, or the reverse.**
7. **Deploy after each phase**, as today: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` green, one commit, then deploy (engines with `docker compose`, dashboards by pushing).

---

## 3. Target architecture

### 3.1 Runtime topology

```
Browser ──https──▶ Vercel: cryptomarketbot.app, stockmarketbot.app (unchanged) ──▶ MongoDB Atlas (unchanged)
   │                                                                              ▲
   └── wss://engine.<domain>/v1/stream ──▶ Caddy (Windows host, unchanged)        │
                                             ├─▶ 127.0.0.1:8787  crypto-engine ───┤
                                             └─▶ 127.0.0.1:8788  stock-engine  ───┘
                     marketbots stack:  crypto-engine, stock-engine ──▶ scraper (Playwright: render + article extract), no host port
                                                                    ──▶ llm (Ollama, RTX 3070), no host port
External: Kraken (CLI wallet in its volume), Alpaca, Vercel AI Gateway (Grok), ~150 news sources
```

- Engine ports, the Caddy sites and every domain stay as they are, so the dashboards and the live stream need no changes. The dashboards are at `cryptomarketbot.app` and `stockmarketbot.app`; the engines at `engine.cryptomarketbot.app` and `engine.stockmarketbot.app`.

### 3.2 Repo layout

```
marketbots/
├─ apps/
│  ├─ crypto-engine/   @mb/crypto-engine   (was cryptomarketbot/apps/engine)
│  ├─ crypto-web/      @mb/crypto-web      (was cryptomarketbot/apps/web)      → Vercel project (crypto)
│  ├─ stock-engine/    @mb/stock-engine    (was stockmarketbot/apps/engine)
│  ├─ stock-web/       @mb/stock-web       (was stockmarketbot/apps/web)       → Vercel project (stock)
│  └─ scraper/         @mb/scraper         one sidecar; keeps its own npm lockfile, outside the pnpm workspace
├─ packages/
│  ├─ core/            @mb/core            shared schemas + pure helpers (no I/O)
│  ├─ crypto-core/     @mb/crypto-core     crypto schemas (was cryptomarketbot/packages/core)
│  ├─ stock-core/      @mb/stock-core      stock schemas (was stockmarketbot/packages/core)
│  ├─ engine-kit/      @mb/engine-kit      engine runtime building blocks
│  ├─ wire/            @mb/wire            news engine core + shared sources + article enrichment
│  ├─ ui/              @mb/ui              shadcn primitives + shared React components + design tokens
│  ├─ web-kit/         @mb/web-kit         server-side dashboard helpers (auth, db, commands, queries, metadata)
│  └─ config/          @mb/config          tsconfig base, ESLint config, Vitest presets
├─ docs/               ARCHITECTURE.md (platform), CRYPTO.md, STOCK.md, SERVER.md, plans/
├─ compose.yml         name: marketbots
├─ crypto.env.example  stock.env.example
├─ AGENTS.md           repo conventions (package boundaries, how to add shared code)
└─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml
```

- Packages are consumed as TypeScript source (`"exports": { "./*": "./src/*.ts" }`), as `packages/core` is today. The engines bundle them with esbuild, Next.js uses `transpilePackages`, and Vitest reads TS directly, so no package needs a build step.
- **Plain pnpm workspaces**, as today. Turborepo isn't needed at this size; `pnpm --filter` and `pnpm fetch` cover the Docker builds.

### 3.3 What each shared package holds

**`@mb/core`**: pure, shared by every app

| Module | Contents | Source |
|---|---|---|
| `math` | as today | identical in both |
| `stream-token` | sign/verify with the HMAC context prefix as a parameter. The prefixes stay `cmb-stream.` / `smb-stream.`, so tokens can never cross bots | both (b) |
| `settings` | helpers (`pct`, `int`, `modelId`, `DeepPartial`, `mergeSettings`, generic `applySettingsPatch`, `diffSettings`), plain-object base schemas `aiSettingsBase` and `wireSettingsBase`, and the ascending-thresholds check. Each bot `.extend()`s them and refines last (Zod 4 restricts `.extend()` on refined objects) | both (split) |
| `commands` | the 8 shared command schemas (`pause`, `resume`, `kill_switch.*`, `settings.update`, `seed.*`, `wire.replay`), base labels and the command envelope. Each bot builds its own `discriminatedUnion` | both (split) |
| `events` | the envelope (`EngineEvent<M,T>`, `eventEnvelopeSchema`, visibility, stream protocol frames, `eventForViewer` taking the owner-only set) and `BaseEventDataMap` with the ~25 events that are the same name **and** payload in both bots (`engine.*`, `research.query/source/progress/completed`, `ai.decision.completed/failed`, `command.*`, `wire.*`, `seed.*`, `budget.exhausted`, `error`, `alert`) | both (split) |
| `db` | base collection names and `INDEXES` (identical today), shared doc types (`SettingsDoc<S>`, `CommandDoc<C>`, `EventDoc<E>`, `EngineStateDoc`, `LeaseDoc`, `AuditDoc`, `NotificationDoc`, `AiCallDoc`, `SeedRunDoc`, `LoginAttemptDoc`, `EngineStatusBase`, `CycleDocBase`), `utcDay` | both (split) |
| `wire` | item/trigger/source-health/dossier types. `WireCategory` becomes a type parameter and `CATEGORY_BASE` is injected per bot | both (b) |
| `metrics` | trade stats, drawdown, performance metrics, Brier score, log-loss, calibration | crypto (generic; stock gains it) |
| `indicators` | EMA/SMA/RSI/Wilder ATR/Bollinger/realized vol/correlation/trend. Stock's call sites pass options that keep today's values (flat-series RSI 100, SMA ATR) until Phase 9 | crypto library |
| `time` | generic time-zone and day helpers (the NY-specific parts stay in stock-core) | stock |

**`@mb/engine-kit`**: engine runtime, generic over each bot's settings, events and commands

| Module | Contents | Notes |
|---|---|---|
| `log`, `lease`, `heartbeat`, `util/{async,text,http}` | as today | identical; `http` takes the default User-Agent |
| `bus` | `EventBus<M>` with the ephemeral set injected | identical |
| `stream` | the WebSocket server | identical |
| `commands` | the processor (expiring set and schema injected) | (b) |
| `db` | `connectMongo({ appName, collections })` with retry | (b) |
| `state` | `SettingsStore<S>` (stock's version: `SettingsView`, env seed hook), `EngineStateStore`, `SeedRuns` | (b) / mirrored |
| `alerts` | **stock's version** (fields, icons, 429/5xx retry, logs every alert), Discord username as a parameter | crypto adopts it (low-risk, listed in Phase 6) |
| `ai/budget` | the day function (UTC vs. NY) and default estimates injected | (b) |
| `ai/repair` | the lenient zod primitives and `extractJson` | identical parts only |
| `ai/runner` | **stock's version** (streamed decisions, reasoning deltas, gateway cost from `finish-step`). `stream: false` keeps crypto's current non-streamed decision call until Phase 9 | (c) |
| `ai/prompt-parts` | `eventSection()`, the gap-fill template and `fenceUntrusted` | identical parts |
| `control` | composition pieces cut out of both `engine.ts`: `ControlPlane` (pause/resume, kill switch, `settings.update`, seed lifecycle, `wire.replay`), `StatusReporter` (base `engine_status` fields + a bot section callback), `EventCycleQueue` (request/drain/merge by symbol, expiry and gate hooks). Composition, not a base class | (c) |
| `bootstrap` | the shared boot order and shutdown from both `main.ts` (env → logger → Mongo retry → lease → bus → settings → state → alerts → stream → wire) with a hook for broker and market wiring | (b) |
| `env` | base zod env schema (the shared variables), trimming, readable errors; each bot `.extend()`s | (b) |
| `testing` | the in-memory Mongo helper, fake bus, fetch/timer helpers, env setup | from both test helpers |

**`@mb/wire`**: the news engine. It contains:
- All 24 mirrored files: `wire.ts`, `normalize`, `cluster`, `severity`, `notable`, `dossier`, `trigger`, `anomaly`, `metrics`, `calendar`, `fetch`, `limiter`, `poller`, `types`, `kinds/*`, `macro-calendar.json`, `sources/bluesky`.
- `sources/macro-actuals` (identical but never marked mirrored).
- `sources/common` (stock's superset).
- `sources/odds` with the Polymarket tags, selection rules and Kalshi series table as parameters.
- Attention building blocks (Wikipedia pageviews, App Store ranks, StockTwits, ApeWisdom).
- `sharedCatalog()`: the gov/macro/Fed/SEC/DOJ/OFAC/White House/Truth Social/ForexFactory entries both catalogs define today, with category hints per bot.
- A `makeLexicon()` skeleton (escaping, matcher cache, polarity).
- `enrich/` (Phase 10 summaries).

Each engine injects `CATEGORY_BASE`, its settings type and its bus. `WireDeps` and `PolicyDeps` already take everything else by constructor.

**`@mb/ui`**: client-safe React. It contains:
- **Primitives:** the 18 shadcn primitives (identical) and `styles.css`, the design tokens. Crypto's tokens are the superset, including the colour-blind-safe `--up`/`--down` and the hex chart tokens.
- **App-shell components:** `bits` (Delta, Stat, PageHeader, KV, merged badge maps), `useCommand<C>()`, `Providers<E>`, `useEngineStream({ maxEvents, mapTicker })`, and the live-UI shell (StatusPill, ActivityFeed, CurrentWork, LivePrice, StreamBadge) driven by a per-bot **event catalog** (labels, icons, filters, detail renderer, links).
- **Page sections:** cycle-trail primitives (Step, StepIcon, Excerpt, DossierRows, Checks), `wire.tsx` (stock's version: ItemTitle, DossierRows, live `TriggerList` with `aria-live`), the engine-card shell, `SiteHeader` (brand name and logo slots), the settings form engine (sections passed in), the system-health shell (venue/broker slots), the seed card, the login form, the error and not-found pages, and the analytics news-engine section and AI-cost table.
- **Wiring:** each app's `globals.css` does `@import "@mb/ui/styles.css"` plus an `@source` for the package (Tailwind v4 doesn't scan workspace symlinks by itself). `components.json` lives in the package so `shadcn add` lands there.

**`@mb/web-kit`**: server-only. It contains:
- **Auth:** `createAuth({ appName, ipSalt, db, env })`, which is Better Auth with the Mongo adapter, magic link via useSend, owner-only sign-in and login rate limits. Each dashboard still has its own secret, database, domain and owner check; only the factory is shared. `ipSalt` stays `cmb-ip.` / `smb-ip.` so existing hashed rate-limit records stay valid. Also `owner`, `auth-client` and `email(appName)`.
- **Data and env:** `createDb({ globalKey, appName, collections })` and the env base schema.
- **Commands:** the commands library and route factories (`commandsRoute`, `commandRoute`, `streamTokenRoute(prefix)`).
- **Shared queries:** engine, admin, audit, commands, notifications, seed runs, events, wire items/facets/triggers/analytics, AI costs.
- **Formatting:** base `format` (`usd`, `pct`, `num`, `ago`, `duration`…) with the time zone passed in (crypto `NEXT_PUBLIC_DISPLAY_TIMEZONE`, stock New York).
- **Metadata:** `site`/`pageMetadata`, the OG template (logo and host slots), and factories for `robots`, `sitemap` (dynamic-entries callback), `manifest` and `apple-icon`.
- **Error reporting:** `instrumentation` + `alerts` (Discord on `onRequestError`; crypto gains it).

### 3.4 What stays per bot (by design)

| Crypto | Stock |
|---|---|
| Kraken CLI wallet, books, ledger, reconciliation, WS book, candles, backtester, strategies, risk engine | Alpaca REST/streams, orders/OCO/brackets, options (menus, entries, exits), scheduler/sessions, price board and layers, scan universe |
| Prompts, AI output schema (moves from `engine/src/ai/schema.ts` to `crypto-core` for symmetry with stock's `report.ts`) | Prompts, report schema |
| Wire catalog, lexicon rules, policy rules, domain sources (chain, DefiLlama, derivatives, Korea, hacks…) | Wire catalog, lexicon rules, policy rules, domain sources (EDGAR, halts, FDA, insiders, congress, MarketBeat…) |
| Same-name events with different payloads (`market.ticker`, `cycle.*`, `order.*`, `position.*`, `risk.checked`…), `engine_status` bot section, `cycles`/`decisions`/`daily_stats` shapes | Same |
| Pages: dashboard, holdings, markets/[pair], decisions/[id], strategies + backtests, `/api/candles`, decision card, tables, charts (until Phase 9), `buildTrail` | Pages: dashboard, holdings, markets/[symbol], research/[id] report, options tab, public JSON API, report view, market status, tables, charts (until Phase 9), `buildTrail` |

### 3.5 Where the two versions differ: which one wins

| Concern | Winner | When |
|---|---|---|
| Alerts (`alerts.ts`) | stock | Phase 6 (message format changes slightly; low risk) |
| AI runner | stock code, crypto keeps `stream: false` | shared in Phase 6; crypto streams in Phase 9 |
| Event-cycle queue | stock (30-min expiry, session gate hook) | shared in Phase 6 with crypto `expireAfterMs: null`; crypto gets expiry in Phase 9. This fixes a real bug: a trigger queued while paused fires on resume |
| Indicators | crypto library | shared in Phase 5 with stock's current semantics as options; stock switches in Phase 9 only if the owner wants it |
| `wire/sources/common.ts`, `odds.ts` | stock (superset, cross-tag dedupe) | Phase 7, only if crypto's parsed-fixture snapshots stay identical; otherwise Phase 9 |
| `wire.tsx` UI | stock (ItemTitle, live TriggerList, a11y) | Phase 8 (visible to the owner) |
| Error page | crypto's (digest + hint) | Phase 8 |
| `robots.ts` | crypto's (`/login` and `/admin` crawlable + `noindex`; a disallow would stop Google from seeing the noindex) | Phase 8 |
| `manifest.ts` | shared; fixes stock's link to a missing `/icon.svg` | Phase 8 |
| Link prefetch | Next's default everywhere (stock's 30 explicit `prefetch` = extra Atlas reads per page view) | Phase 8 |
| Charts | keep both libraries until Phase 9, then one library (rec. `lightweight-charts`: every chart is a time series, canvas, markers for ▲▼) | Phase 9 (owner sees screenshots first) |

### 3.6 Environment files

- **`crypto.env`** at the repo root holds everything the crypto engine and crypto dashboard read. It merges today's server `.env` and the list of Vercel variables into one file, under today's variable names, so the code needs no renames. **`stock.env`** does the same for stocks. Example files are committed and the real files are git-ignored.
- **Engines:** compose sets `env_file: crypto.env` for the crypto engine and `stock.env` for the stock engine. Compose `environment:` sets only what the stack decides: `STREAM_HOST`, `STREAM_PORT`, `SCRAPER_URL=http://scraper:8790` and `LLM_URL=http://llm:11434`.
- **Dashboards:** local dev reads the same file through the app's scripts. Vercel can't read files from this server, so the file's dashboard section is the list of values set in each Vercel project, as today; `docs/SERVER.md` says which.
- **Local dev overrides:** `crypto.local.env` (git-ignored) holds things like a `cryptomarketbot_dev` database name and no Discord.
  - Engines use `tsx --env-file-if-exists=../../crypto.env --env-file-if-exists=../../crypto.local.env`.
  - Dashboards use `node --env-file-if-exists=… ./node_modules/next/dist/bin/next dev`.
  - Node lets later files override earlier ones, so no dotenv dependency is needed.
- **Accepted trade-off:** one file per bot means each engine container also receives its dashboard's secrets. It already does today (both apps read the same `.env`). Same owner, same host, same bot; accepted.

### 3.7 Dashboards stay on Vercel

- **Re-link both Vercel projects** from the old repos to `colinfran/marketbots` in Phase 4:
  - Root Directory `apps/crypto-web` / `apps/stock-web`.
  - "Include files outside the root directory" on (the apps use `packages/*`).
  - Node 22; pnpm is detected from the root lockfile.
  - Env vars, domains and auth don't change.
- **Ignored Build Step** in each project, so a push that only touches the other bot doesn't rebuild this one. For crypto: `[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- :/apps/crypto-web :/packages/core :/packages/crypto-core :/packages/ui :/packages/web-kit :/packages/config :/pnpm-lock.yaml || exit 1`, where exit 0 means skip; it builds when the previous SHA isn't set. The `:/` prefix anchors each path at the repo root: Vercel runs the command from the Root Directory, where a plain `apps/crypto-web` would never match and every build would be skipped (found 2026-10-26; full commands in `docs/SERVER.md`).
- **Nothing changes for visitors during the build-out.** Until the re-link, Vercel keeps building from the old repos.
- **Bad deploys:** Vercel's instant rollback covers them, as today.

### 3.8 One shared scraper

- **One container** (`scraper`, 1 GB), reached by both engines at `http://scraper:8790`.
- **Concurrency** goes from 2 to 3. A per-caller queue cap (`X-Client: crypto|stock`) means one bot can't starve the other.
- **New `POST /extract { url, render: "auto" | "never" | "always" }`:**
  - **Fetch:** a plain fetch first, falling back to a headless render if the text comes out short.
  - **Extract:** Mozilla Readability (`@mozilla/readability` + `linkedom`), returning `{ title, byline, published, lang, text, words }`.
  - **Respect sites:** checks robots.txt (cached 24 h) and skips paywalled or disallowed domains.
  - **Stores nothing.**
- **Optional later:** a shared fetch cache and cross-engine rate limits for URLs both bots poll (ForexFactory, SEC, Fed, OFAC, Polymarket…). Phase 11, because it would make the sidecar a dependency of every news source.

### 3.9 Local article summaries (Llama 3.2 3B, GPU only)

**Chrome's built-in Summarizer was considered and rejected:**
- It needs Google Chrome (not Playwright's Chromium) and a user gesture to download its model.
- Inside a container it can't use the GPU, and its CPU path needs 16 GB RAM. The Docker VM has 11.6 GiB.
- No source confirms it works in headless mode.

**What to summarize:**
- **Assumption:** the pages the scraper renders today are listing pages (tables, calendars), and no source uses them yet. The useful target is **the article behind each important news item**.
- **Which items:** cluster roots at severity ≥ `wire.summaries.min_severity` (default 55, "review a holding"), or notable items. The item must have an article URL, an allowed domain and English text.

**Flow (in `@mb/wire/enrich`, the same code in both engines):**
1. A bounded queue in each engine picks up qualifying items.
2. `POST scraper/extract` returns the article text, cut to about 3,000 tokens.
3. `POST llm/api/chat` sends it with `{ model, format: <JSON schema: summary ≤ 80 words, key_points ≤ 4>, options: { temperature: 0, num_ctx: 4096 }, keep_alive: "5m" }`.
4. The result is stored on the wire item: `article: { status, reason?, summary, key_points, words, model, ms, at }`. The summary is stored, the full text is not.
   - **Atlas storage:** each summary adds under 1 KB to a `wire_items` document, and those documents already expire after 30 days, so the extra space is negligible (est. < 10 MB per bot at steady state).

**How summaries are used:**
- **Never on the trigger path.** Triggers fire on the headline as today (90 s target). A summary that is ready when a decision prompt is built goes in fenced as `<untrusted>`, like any web content, and `PROMPT_VERSION` is bumped. The Research page shows summaries under each item.

**Memory and speed limits (the PC is shared):**
- **Ollama settings:** `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `num_ctx` 4096.
- **Footprint:** ~2.5–3 GB of GPU memory, only while working; it unloads after 5 idle minutes.
- **Container caps:** `mem_limit: 2g`, `cpus: 2`.
- **GPU only:** the engine checks `/api/ps` and pauses summaries if the model isn't fully on the GPU, so it never falls back to a slow CPU run.
- **Volume caps:** each engine caps itself (default 60 articles/hour).
- **Admin settings:** `wire.summaries.enabled`, `.model`, `.min_severity`, `.max_per_hour`, `.skip_domains` (WSJ, FT, Bloomberg, NYT, Economist, Barron's, Seeking Alpha…) and optional `.pause_hours` (decision 4).
- **Health:** shown as source `enrich:summaries`.
- **Expected speed:** 2–4 s per article on the RTX 3070 (estimate; measured in 10.1). Jellyfin's transcoding uses NVENC, which is separate hardware.

**Model choice:** `llama3.2:3b` by default. Phase 10.1 compares it with `qwen3:4b` (instruct), `phi4-mini` and `gemma3:4b` on 20 real articles from `wire_items`:
- **Judged on:** faithfulness (no claim the article doesn't make), whether numbers are kept, p50/p95 latency and peak GPU memory.
- **Switch rule:** another model wins only if it is clearly better **and** stays within 3.5 GB of GPU memory and 6 s p95.
- **Pinning:** the model tag is pinned and its digest recorded.

### 3.10 Memory budget (Docker VM: 11.6 GiB; ~4.6 GiB used today by all containers)

| Service | Limit | Expected | Today |
|---|---|---|---|
| crypto-engine | 1 GB | ~0.35 GB | 0.32 GB |
| stock-engine | 1 GB (up from 768 MB: headroom at the open with 1,500 tracked symbols) | 0.3–0.5 GB | 0.28 GB |
| scraper (one) | 1 GB | 0.15 GB idle, ≤0.5 GB rendering | 2 × 0.12 GB |
| llm | 2 GB RAM, 2 CPUs; GPU ~2.4 GB (llama3.2:3b) only while loaded | ~0.1 GB idle; **at its 2 GB cap while a model is loaded** (mostly reclaimable cache; measured in 10.1), 2 CPUs while generating; 0 GPU when idle | — |
| **Total** | 5 GB of caps | **~1–1.5 GB typical** (+0.5 GB vs today) | 0.85 GB |

Typical VM use goes from ~4.6 to ~5.2 GiB of 11.6 GiB, so no `.wslconfig` change is needed.

### 3.11 `compose.yml` (sketch)

```yaml
name: marketbots

x-hardened: &hardened
  restart: unless-stopped
  read_only: true
  tmpfs: [/tmp]
  security_opt: [no-new-privileges:true]
  cap_drop: [ALL]
  logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }

services:
  crypto-engine:
    <<: *hardened
    build: { context: ., dockerfile: apps/crypto-engine/Dockerfile }
    container_name: marketbots-crypto-engine
    env_file: crypto.env
    environment: { STREAM_HOST: 0.0.0.0, STREAM_PORT: 8787, SCRAPER_URL: http://scraper:8790, LLM_URL: http://llm:11434 }
    ports: ["127.0.0.1:8787:8787"]          # same port as today: Caddy is unchanged
    volumes: [kraken-paper:/data/kraken]
    stop_grace_period: 30s
    mem_limit: 1g

  stock-engine:   # same shape: stock.env, 127.0.0.1:8788, no volume, mem_limit 1g
  scraper:        # no ports, init: true, mem_limit 1g
  llm:
    image: ollama/ollama:<pinned>
    profiles: [llm]               # off until Phase 10
    environment: { OLLAMA_NUM_PARALLEL: 1, OLLAMA_MAX_LOADED_MODELS: 1, OLLAMA_KEEP_ALIVE: 5m, OLLAMA_FLASH_ATTENTION: 1, OLLAMA_KV_CACHE_TYPE: q8_0, OLLAMA_MAX_QUEUE: 64 }
    volumes: [ollama-models:/root/.ollama]
    deploy: { resources: { reservations: { devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }] } } }
    mem_limit: 2g
    cpus: 2

volumes:
  ollama-models:
  kraken-paper: { external: true, name: cryptomarketbot_kraken-paper }   # THE paper wallet; never let compose create a new one
```

**Critical:** compose prefixes volume names with the project name. Without `external: true` the new project would create an empty `marketbots_kraken-paper`, and the crypto engine would see a wallet reset. Copying it to a `marketbots_` name is optional cleanup for later (Phase 11).

---

## 4. Phases and tasks

Tags: **[C]** crypto, **[S]** stock, **[both]**, **[stack]** Docker/infra, **[owner]** needs the owner. Paths are relative to `marketbots/` unless noted.

### Phase 0: Preconditions (≈ ½ session)

- [x] 0.1 [owner] Answer the decisions in §7.
- [x] 0.2 [both] **Tonight's schedule (owner, decision 5).** Phases 0–4 on 2026-10-26/27 night.
  - **Cutoff:** the swap must be done and verified by **04:00 PT (07:00 ET)**. That is before the stock premarket cycle (~08:00 ET) and the seeds (stocks ~06:40 PT, crypto 06:45 PT).
  - **If not ready by the cutoff:** no swap. The old containers run the seeds, and the swap follows after ~10:00 ET.
  - **The swap also deploys MASTER_PLAN Phase 7** (the held-back sources, the newsletters and `SCRAPER_URL`), because the new images are built from both repos' HEAD.
  - Phases 5–11 start after the seeds.
  - **Checked 23:20 PT:** both seed runs are `scheduled` in Atlas (stock 13:30 UTC, crypto 13:45 UTC). The seed docs live in the database both old and new engines use, so whichever engine holds the lease at that time runs them. For tonight, read the runbook's "no seed run is scheduled" as "none running and none due before the swap is verified". The cutoff leaves 2.5 h of margin.
  - **Source counts rise at the swap:** the live images predate MASTER_PLAN Phase 7. Runbook step 3 compares against the HEAD catalog counts in §8 (crypto 78, stock 89), not the live heartbeat (71 / 83).
- [x] 0.3 [both] Record baselines from the old repos (results in §8):
  - Commit SHAs.
  - `pnpm typecheck/test/lint/build` results.
  - Exact test counts per package (crypto engine ~177 and stock engine ~519 per MASTER_PLAN §9; re-measure).
  - Container memory at the market open.
- [x] 0.4 [both] Start the **port log** (§8): from the Phase 2 copy until the swap, every change to the old repos (hotfixes only) is logged and ported.

### Phase 1: Scaffold `marketbots` (≈ ½ session)

- [x] 1.1 [stack] `git init` in `C:\Users\colin\Documents\GitHub\marketbots` (exists, empty):
  - `.gitattributes` (`* text=auto eol=lf`) and `core.autocrlf=false`.
  - `.gitignore`: `node_modules`, `dist`, `.next`, `*.env`, `*.local.env`, `!*.env.example`.
  - `.dockerignore` (same, plus docs).
- [x] 1.2 [stack] Root `package.json`:
  - `marketbots`, pnpm 10.12.1, node ≥22.12.
  - Scripts `dev:crypto-engine`, `dev:crypto-web`, `dev:stock-engine`, `dev:stock-web`, `build`, `test`, `typecheck`, `lint`, `backtest`.
  - `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `!apps/scraper`, plus today's `onlyBuiltDependencies`.
- [x] 1.3 [stack] `packages/config`:
  - `tsconfig.base.json` (today's, identical in both).
  - The shared ESLint config (Next preset + the §2.6 import boundaries).
  - Vitest presets: an engine preset (memory-server global setup) and a web preset (`@` alias).
- [x] 1.4 [stack] `crypto.env.example` and `stock.env.example`: today's `.env.example` per bot, with the header saying the engine reads the file through compose and the dashboard section goes into Vercel.
- [x] 1.5 [stack] Copy this plan and `MASTER_PLAN.md` into `docs/plans/`.
- [ ] 1.6 [owner] Create the GitHub repo `colinfran/marketbots` (private). The owner pushes, as today.

### Phase 2: Move both bots in unchanged (≈ 1 session)

- [x] 2.1 [both] `git archive HEAD` from each repo into place:
  - `apps/engine` → `apps/{crypto,stock}-engine`.
  - `apps/web` → `apps/{crypto,stock}-web`.
  - `packages/core` → `packages/{crypto,stock}-core`.
  - Crypto's `apps/scraper` → `apps/scraper` (identical in both apart from the package name).
  - Both "not carried over" files below are **tracked**, so `git archive` would copy them: exclude them (crypto's root `claude_prompt_grok_vercel_ai_gateway (1).txt`, stock's root `.DS_Store`).
- [x] 2.2 [both] Rename scopes: `@cmb/core` → `@mb/crypto-core`, `@cmb/engine` → `@mb/crypto-engine`, `@cmb/web` → `@mb/crypto-web` (stock likewise), and `@cmb/scraper` → `@mb/scraper` (in `package.json` and `package-lock.json`). Fix relative paths: `tsconfig` extends, vitest configs, `build.mjs`, and the `macro-calendar.json` path in the alert text.
- [x] 2.3 [both] Dev scripts load `../../<bot>.env` + `../../<bot>.local.env` (§3.6).
- [x] 2.4 [both] One `pnpm install` and one lockfile (versions already match; drop stock's stale `@vitest/coverage-v8` peer).
- [x] 2.5 [both] **Contract snapshots**, generated from the unchanged code and committed under `contracts/<bot>/`:
  - `DEFAULT_SETTINGS` (JSON).
  - Settings and command schemas (`z.toJSONSchema`).
  - `INDEXES`.
  - Event type lists.
  - The wire catalog (id, kind, url, interval, tier).
  - Rendered research/decision/gap-fill/event/seed prompts for fixed fixture contexts.
  - Parsed items for every source fixture.
  
  A test fails on any diff. *(Tonight: deferred until after the swap, still before Phase 5. The code doesn't change in between, so the snapshots still capture today's behavior.)*
- [x] 2.6 [both] Gate: everything green, test counts equal to the 0.3 baseline. Commit "Move both bots in unchanged".
- **Not carried over:** `claude_prompt_grok_vercel_ai_gateway (1).txt` and `.DS_Store` (they stay in the archived repos).
- **Lesson (2026-10-26):** archive the whole tree (`git archive HEAD <path>`), not a subtree (`HEAD:<path>`). A subtree has no root `.gitattributes`, so on Windows the global `core.autocrlf=true` writes CRLF. Blobs were normalized on commit; a fresh checkout fixed the working tree.

### Phase 3: The Docker stack (≈ 1 session)

- [x] 3.1 [stack] `compose.yml` as in §3.11. Every service is resource-capped and hardened where the image allows.
- [x] 3.2 [both] Engine Dockerfiles for the monorepo:
  - Build stage: `pnpm fetch` (lockfile only, cache-friendly), then copy sources, then `pnpm install --offline --frozen-lockfile --filter @mb/<bot>-engine...`, then esbuild. The runtime image is unchanged: `node:22-bookworm-slim` pinned by digest, tini, non-root, healthcheck.
  - Crypto keeps the checksummed Kraken CLI stage and `/data/kraken`.
- [x] 3.3 [stack] Merged scraper: one service, concurrency 3, per-caller queue cap, 1 GB.
- [x] 3.4 [both] Smoke test of the new images, using a separate compose project name and other ports so the live engines aren't touched:
  - **Crypto:** against a fresh `cryptomarketbot_staging` database on Atlas, with a **copy** of the wallet volume, no AI key and no Discord, for about an hour. Check boot, lease, indexes, stream and source health.
  - **Stock (decision 3):** boot test only, with **fake** Alpaca keys and a throwaway local MongoDB. It must reach healthy, take the lease, open the stream and log Alpaca auth errors without crashing. The live keys are never used while the old engine runs: Alpaca's free market-data stream allows one connection per account, so they would knock out the live engine's prices.
  - **Tonight's shortcut:** both boot tests use a throwaway `mongo:8.0` container instead of an Atlas staging database, and last a few minutes, not an hour. Nothing is written to Atlas.
- [ ] 3.5 [owner, optional] A temporary Vercel project per dashboard linked to the new repo, to see a green preview build of the monorepo before re-linking the real projects. Delete them afterwards.
- [x] 3.6 [both] Docs: `docs/SERVER.md` replaces both `WINDOWS_SERVER_SETUP.md` files (one stack, one runbook, which values go into Vercel).

**Done when:** both images pass the smoke test, and both dashboards build from the new repo.

### Phase 4: Swap over (≈ ½ session)

- [x] 4.1 [both] Swap the engines per the §5 runbook: **stock first** (weekend or after 20:00 ET), **then crypto** (quiet hour; the swap takes a minute or two).
- [ ] 4.2 [owner] Re-link both Vercel projects to the new repo (§3.7), set the Ignored Build Step, deploy. Check both dashboards: signed in, stream connects, a `pause`/`resume` round trip works.
- [x] 4.3 [both] Remove the old scraper containers. Keep the old compose projects stopped (not removed) for 14 days, then remove them with owner approval.
- [ ] 4.4 [owner] Archive both old GitHub repos, read-only, once Vercel no longer builds from them.
- [x] 4.5 Update memory: the repo, the stack, and where progress lives.

### Phase 5: `@mb/core` and per-bot cores (≈ 1 session)

- [x] 5.1 Create `@mb/core` with: `math`, `stream-token` (prefix parameter), `wire` (category parameter), `settings` base pieces and helpers, `commands` base, `events` envelope + `BaseEventDataMap`, `db` base collections/indexes/types, `metrics`, `indicators`, generic `time` (§3.3).
- [x] 5.2 Make `crypto-core` and `stock-core` extend it. Move crypto's AI schema from the engine to `crypto-core`.
- [x] 5.3 Move tests (`commands.test.ts` is identical in both: keep one).
- [ ] 5.4 Gate: contract snapshots unchanged, counts ≥ baseline. Deploy both engines and both dashboards.

### Phase 6: `@mb/engine-kit` (≈ 1–2 sessions)

- [x] 6.1 Move the identical modules as-is: `log`, `lease`, `heartbeat`, `bus`, `stream`, `util/*`.
- [x] 6.2 Move the parameterized ones: `commands` processor, `db` connect, `state/*`, `ai/budget`, `env` base, the `ai/repair` primitives, prompt parts.
- [x] 6.3 `alerts` (stock's version; crypto's Discord messages gain fields and retry: **listed behavior change, low risk**).
- [x] 6.4 `ai/runner` (stock's version; crypto calls it with `stream: false`).
- [x] 6.5 Cut `ControlPlane`, `StatusReporter`, `EventCycleQueue` and `bootstrap` out of both `engine.ts` / `main.ts`. Each engine keeps its domain loops. Crypto's queue keeps "no expiry" for now.
- [x] 6.6 `testing` helpers shared by both engines.
- [ ] 6.7 Gate as in 5.4, plus a boot of both engines against the staging databases (as in 3.4) before deploying.

### Phase 7: `@mb/wire` (≈ 1 session)

- [ ] 7.1 Move the 24 mirrored files, `macro-actuals` and `kinds/*`, and delete the "Mirrored… keep in sync" headers (there is only one copy now).
- [ ] 7.2 Shared source helpers: `common` (stock's superset), parameterized `odds`, attention building blocks, `sharedCatalog()`, `makeLexicon()` skeleton. Crypto adopts each one only if its parsed-fixture snapshots are unchanged; otherwise it waits for Phase 9.
- [ ] 7.3 Per bot, `apps/<bot>-engine/src/wire/` keeps the catalog (built on `sharedCatalog()`), lexicon rules, policy and domain sources.
- [ ] 7.4 Gate as in 6.7. Watch the source-health count in the heartbeat match the pre-deploy count.

### Phase 8: `@mb/ui` and `@mb/web-kit` (≈ 2 sessions)

- [ ] 8.1 `@mb/ui`: the 18 primitives (make `dialog.tsx`'s one `@/` import relative), `styles.css` (crypto's token superset), `components.json`. Each app's `globals.css` imports it and adds `@source`. Remove unused primitives only if no app uses them (`progress`, `scroll-area`, `separator`, `textarea`).
- [ ] 8.2 Shared components (§3.3): bits, useCommand, providers, stream hook, live-UI shell + per-bot event catalogs, cycle-trail primitives, `wire.tsx` (stock's), engine card, site header (brand slots: crypto `BotMark`, stock lucide `Bot`), settings form, system-health shell, seed card, login, error/not-found, analytics news section.
- [ ] 8.3 `@mb/web-kit` (§3.3), including the shared queries module that replaces the common half of crypto `lib/data.ts` and stock `lib/queries.ts`. Instrumentation + Discord request errors for crypto too.
- [ ] 8.4 Policy picks from §3.5: error page, robots, manifest fix, prefetch default.
- [ ] 8.5 Gate: `next build` both. Before/after screenshots of every page in both apps at desktop and phone width, from Vercel preview deployments (visible changes only from 8.2's `wire.tsx` and 8.4). Owner reviews, then deploy.

### Phase 9: Deliberate improvements (owner approves each; one commit and deploy each)

- [ ] 9.1 [C] Event-queue expiry and gate hooks, as in stock (a trigger queued while paused no longer fires on resume).
- [ ] 9.2 [C] Streamed decisions + reasoning deltas + per-attempt gateway cost (runner `stream: true`, live UI shows decision progress).
- [ ] 9.3 [both] One chart library (rec. `lightweight-charts`); shared `PriceChart`, `EquityChart`, `PnlChart` in `@mb/ui`. Screenshots first.
- [ ] 9.4 [S] Optional: standard Wilder ATR and flat-series RSI 50 (changes indicator values in stock prompts; bump `PROMPT_VERSION`).
- [ ] 9.5 [C] Any `common`/`odds` adoptions that 7.2 held back.

### Phase 10: Local article summaries (≈ 2 sessions)

- [x] 10.1 [stack] Spike:
  - Start `llm` (`--profile llm`) and confirm the GPU inside the container.
  - Pull `llama3.2:3b`, `qwen3:4b`, `phi4-mini`, `gemma3:4b`.
  - Run all four on 20 real articles from `wire_items` and record faithfulness, latency p50/p95, peak GPU memory and RAM with all other services running.
  - **Go/no-go:** a model within 3.5 GB GPU memory and 6 s p95 that keeps the article's facts. If none qualifies, stop and report.
  - **Result (2026-10-27, `docs/plans/PHASE10_SPIKE.md`): conditional GO for `llama3.2:3b`; the owner must confirm.**
    - **Within the limits:** p95 3.2 s and 2.4 GB of GPU memory, with valid JSON on all 20 articles.
    - **Not fully faithful:** it made 3 material errors in 20 articles. A stricter prompt removed the one invented number but not the other 2 errors. No model was fully faithful.
    - **Alternatives:** none was clearly better. gemma3:4b failed every limit.
    - **Pinned:** model digest `a80c4f17…5b8b72`; Ollama image `0.40.11@sha256:dea72d1e…` in compose.yml.
    - **Mitigations for 10.3:**
      - Use the stricter prompt.
      - Check every number in a summary against the article.
      - Select only real articles: skip halts, social posts and odds, and drop texts under 150 words.
      - Label each summary as a machine summary.
    - **Until the owner confirms, 10.5 waits:** summaries can be stored and shown (10.3–10.4) but don't go into decision prompts.
- [x] 10.2 [stack] Scraper `POST /extract` (§3.8) with robots.txt and skip-domain checks; tests against saved article fixtures.
- [ ] 10.3 [both] `@mb/wire/enrich`: queue, selection, extract → summarize → store, the GPU-only guard, hourly cap, `enrich:summaries` health. Never on the trigger path.
- [ ] 10.4 [both] `wire.summaries` settings section (defaults: enabled, the 10.1 model, `min_severity` 55, 60/h, skip list), shipped live like the `wire` section was.
- [ ] 10.5 [both] Dossier rows gain the summary (fenced, capped); bump `PROMPT_VERSION`. Research page and item detail show it.
- [ ] 10.6 Watch for 2 days: GPU memory over time, summaries per hour, failures by reason, effect on Grok research spend.

### Phase 11: Later and optional

- [ ] A shared outbound fetch cache + cross-engine rate limits for URLs both bots poll (ForexFactory, SEC, Fed, Polymarket…), and one Bluesky Jetstream consumer instead of two.
- [ ] Change streams instead of the 1-second command poll (check the Atlas tier supports them).
- [x] A nightly backup of the Kraken wallet volume (today it has none). *(Done 2026-10-26: compose service `wallet-backup`, daily 10:00 UTC to `backups/kraken/`, 14 kept.)*
- [ ] Copy the wallet volume to a `marketbots_` name and drop the `external` reference.
- [x] GitHub Actions CI (typecheck, test, lint, build). Neither repo has CI today. *(Done 2026-10-26: `.github/workflows/ci.yml`, plus the scraper's tests; it runs once the repo is on GitHub.)*
- [ ] Carry over MASTER_PLAN's open work: 8.2 and 8.3 tuning, and its Phase 9.

---

## 5. Swap runbook (per bot)

**Before:**
- Phase 3 is done.
- No seed run is scheduled or running, and no cycle is running.
- **Stock:** a weekend or after 20:00 ET. Stops are resting orders at Alpaca; options exits need the engine.
- **Crypto:** a quiet hour. Stops are watched only by the engine, but the swap takes a minute or two.

1. `docker compose -p <old project> stop` (the old engine and its scraper). Check `docker ps`: the old engine is gone. While it runs, the new engine can't start anyway, because the port is taken.
2. `docker compose up -d <bot>-engine scraper` in `marketbots`. Crypto mounts the **existing** `cryptomarketbot_kraken-paper` volume.
3. Verify:
   - `/healthz` and `/readyz`.
   - Logs show `engine lease acquired` (the old lease lapses within 30 s).
   - **Crypto:** reconciliation clean, wallet vs. books. **Stock:** order sync clean and positions match Alpaca.
   - Source health ≈ the pre-swap count.
   - The dashboard shows the engine Running and the stream connects. No dashboard change is needed: same port, same proxy, same database.
4. Watch for an hour, then for the rest of the day (memory, errors, triggers, AI spend).

**Rollback:** `docker compose stop <bot>-engine` in `marketbots`, then `docker compose -p <old project> start`. Both use the same database and the same wallet volume, so nothing needs copying back. Dashboards roll back with Vercel's instant rollback.

---

## 6. Risks

| Risk | Handling |
|---|---|
| Two engines trading the same wallet or account | Same port and same database lease; the runbook stops the old engine first; smoke tests use a separate database, a copied wallet and separate Alpaca keys |
| New compose project creates an empty wallet volume | `external: true` with the exact old name; checked at step 2 of the runbook |
| A refactor silently changes trading or prompts | Phases 5–8 are gated on byte-identical contract snapshots + test counts; behavior changes only in Phase 9 |
| Vercel re-link misconfigured (root directory, files outside it) | Optional preview project in 3.5; Vercel instant rollback; the old repos stay until the re-link is verified |
| Every push rebuilds both dashboards | Ignored Build Step per project (§3.7) |
| Memory pressure on a shared PC | Every service capped (§3.10); LLM GPU-only and unloads when idle |
| LLM summary contains a prompt injection or a wrong fact | Summaries are untrusted, fenced and capped; never on the trigger path; temperature 0; faithfulness checked in 10.1; owner off switch |
| Fetching full articles crosses site terms | robots.txt check, skip list, store the summary only (no full text) |
| Atlas storage grows from summaries | < 1 KB per summarized item, inside documents that already expire after 30 days |
| The merge drags on while the old repos need fixes | Move-first ordering keeps the freeze to Phases 2–4; port log for any hotfix |

---

## 7. Decisions for the owner

Answered by the owner on 2026-10-26, 23:15 PT:

| # | Question | Answer |
|---|---|---|
| 1 | Git history: fresh, or import both histories? | **Fresh.** The old repos are archived on GitHub after the Vercel re-link |
| 2 | Unify charts on one library in Phase 9? | **Yes**, `lightweight-charts`, after screenshots |
| 3 | A second Alpaca paper account for smoke tests? | **No, use the same account.** The new stock engine is never run alongside the old one (one market-data connection per account): the image is boot-tested with fake keys (3.4), and its first real run is the off-hours swap, with a one-command rollback |
| 4 | Summaries model | **Llama 3.2 3B** (the 10.1 bake-off still records the alternatives). No pause hours unless asked |
| 5 | Timing | **Build now; swap once tests pass and it's ready, before the 2026-10-27 seeds if possible.** Phases 0–4 tonight with a 04:00 PT cutoff (Phase 0.2); Phases 5–11 after the seeds |

---

## 8. Baselines, port log and progress log

**Baselines (0.3)**, recorded 2026-10-26 23:20 PT from clean working trees:

| | Crypto | Stock |
|---|---|---|
| Commit (Phase 2 copies from here) | `35319cc` | `a0a18f2` |
| `pnpm typecheck` / `test` / `lint` / `build` | all exit 0, no warnings | all exit 0, no warnings |
| Tests `packages/core` | 26 (5 files) | 63 (6 files) |
| Tests `apps/engine` | 177 (13 files), 24.6 s | 519 (32 files), 44.3 s |
| Tests `apps/web` | 3 (1 file) | 33 (3 files) |
| **Tests total** | **206** | **615** |
| Lint scope | `apps/web` only (the engine has no lint script) | same |
| Build output | engine `dist/main.js` + `dist/backtest/cli.js`; web 24 static pages | engine `dist/main.js`; web 25 static pages |
| Scraper | outside the pnpm gate (own npm lockfile, no tests) | same |
| Engine container (off-hours) | 316 MiB of 1 GiB; process RSS 344 MB, heap 174 MB | 275 MiB of 768 MiB; RSS 315 MB, heap 156 MB |
| Scraper container (idle) | 134 MiB of 768 MiB | 118 MiB of 768 MiB |
| Wire sources, live heartbeat (pre-MASTER_PLAN-Phase-7 image) | 71: 70 ok, 1 degraded (`gdelt` 429, expected) | 83: all ok |
| Wire catalog at HEAD (what the swap deploys) | 78 | 89 |
| Seed run | `scheduled`, $5,000, 13:45 UTC | `scheduled`, $5,000, 13:30 UTC (runs after the open buffer) |

- All containers on the Docker VM: ~4.7 GiB (off-hours).
- **Memory at the open:** if the swap happens tonight, the old containers never see an open. The 2026-10-27 open is then measured on the new containers and recorded here against the caps (stock: 1 GB new, 768 MB old). If the swap slips past the cutoff, measure the old containers at the open instead.

**Port log** (changes made to the old repos after the Phase 2 snapshot). Started at crypto `35319cc` / stock `a0a18f2`. Phase 2 copies from these commits; if either HEAD has moved by 2.1, log the new commits here first. Check with `git log 35319cc..HEAD` / `git log a0a18f2..HEAD`.

| Date | Repo | Commit | What | Ported |
|---|---|---|---|---|
| 2026-10-26 23:28 PT | cryptomarketbot | `1f52260` | Owner committed the draft `MARKETBOTS_PLAN.md` (docs only) | Not needed: `docs/plans/MARKETBOTS_PLAN.md` here is the live copy |

**Progress log:**

| Date | Phase / tasks | Notes |
|---|---|---|
| 2026-10-26 | — | Plan written from a full comparison of both repos and the server. Revised the same day: Atlas and Vercel stay (owner). Nothing executed. |
| 2026-10-26 23:30 PT | Phase 0 (0.1–0.4) | Owner's §7 answers recorded. Baselines above, all green. Seeds confirmed scheduled. Two Phase 2 notes added: exclude the two tracked stray files from `git archive`, and rename the scraper's package scope. Live containers untouched. |
| 2026-10-26 23:30 PT | Phases 1–2 (2.5 deferred) | Scaffold, then both bots moved in from `35319cc` / `a0a18f2`. The lockfile was seeded from crypto's, so every direct dependency matches both old lockfiles (`recharts` pinned back to stock's 3.8.0). Transitive differences: `victory-vendor` 37.3.6 → 37.4.1 (recharts' d3, dashboard only), plus three build-tool patches crypto already ran; stock's stale `@vitest/coverage-v8` was dropped. Gate green: 206 / 615 tests, equal to the baselines. Lint now covers the engines and cores too (import boundaries only; checked with a probe file). `crypto.env` / `stock.env` were copied from the old `.env` files (git-ignored). Docs carried over unchanged as `docs/CRYPTO.md` and `docs/STOCK.md`. |
| 2026-10-26 23:40 PT | Phase 3 (3.1–3.4) | `compose.yml`; Dockerfiles use `pnpm fetch` + `--offline` install and the runtime `node:22-bookworm-slim` digest the old images used (`de170b39…`). The scraper runs 3 renders at once, with at most 8 of 16 queue places per caller (`X-Client`, else the container address). `compose.smoke.yml` is the reusable boot test. Smoke results: both engines healthy in under 30 s, lease taken, authenticated stream opened (bad token refused with 4003), stock logged Alpaca 401s without crashing, about 200 MiB each. **Finding:** the crypto engine resets the paper workspace when its database is fresh. It only ever gets the wallet copy in the smoke test; never start the live wallet against a new database name. |
| 2026-10-26 23:47 PT | Phase 4 (4.1, 4.3) | **Stock swapped at 23:45 PT, crypto at 23:46 PT.** Each new engine was healthy in about 10 s and took the lease at once (the old one released it on shutdown). Stock: Alpaca REST, trade and data streams connected, 94/96 sources ok. Crypto: reconciliation clean, wallet ok on `cryptomarketbot_kraken-paper`, no workspace reset, 78/80 sources ok. Only `macro_ff` and `gdelt` are degraded (known per-IP rate limits), and there are 0 warn/error log lines. Both answer through Caddy. Both seeds are still `scheduled` (13:30 / 13:45 UTC) and run on the new engines. This also deployed MASTER_PLAN Phase 7 (new sources, newsletters, `SCRAPER_URL`). Old scraper containers removed; old engines `Exited (0)`, kept for rollback until 2026-11-09. Pre-swap state was captured from Atlas (status, broker, wallet, lease, seeds). |
| 2026-10-27 00:00 PT | 3.6, Phase 11 (CI, wallet backup) | Docs written (SERVER.md, ARCHITECTURE.md, README, AGENTS.md). The docs agent found that the §3.7 Ignored Build Step would skip every build when run from the Root Directory; fixed with `:/`-anchored pathspecs, tested. `wallet-backup` service started (first backup 5 KB). `.github/workflows/ci.yml` added. |
| 2026-10-27 00:30 PT | 2.5 | Contract snapshots for both bots: 75 crypto + 84 stock files, +78 / +87 tests, reproducible byte for byte. Gaps: the repair schemas aren't exported (covered by unit tests), crypto prompt inputs are assembled inline in the cycle code (hand-copied fixtures), and stock prompt times depend on Node's `Intl` time-zone data. Known load-sensitive test: stock `engine.test.ts` "pauses, resumes and applies settings…" can time out on a busy machine (passes alone). |
| 2026-10-27 00:40 PT | 10.1–10.2 | `/extract` with 60 tests; 25/33 real URLs ok. Spike: conditional GO for `llama3.2:3b` (see 10.1); 10.5 waits for the owner. The llm service is stopped; models kept in the `ollama-models` volume. |
| 2026-10-27 00:50 PT | Phase 5 (5.1–5.3; deploy pending) | `@mb/core`: math, stream-token, wire, events (`BaseEventDataMap`, 23 events), commands, settings, db, metrics, indicators, time. The bot cores bind their parameters and keep their key order: no `.extend()` and no `Base & {…}` types, because both reorder the snapshots. Stock indicators keep today's values via options (`rsi` flat 100, `atr` SMA); 96,000 random comparisons were bit-identical. Tokens verify both ways between old and new code, and a token from one bot never verifies in the other. Snapshots unchanged; tests 986 → 998. Engine deploy after the seeds (5.4). |
| 2026-10-27 01:40 PT | 6.1–6.4, 6.6 (deploy pending) | `@mb/engine-kit`: log, heartbeat, lease, util/*, bus, stream, commands, db (retry moved in), state stores, seed runs, ai/budget, ai/repair, ai/runner (stock's; crypto binds stream false and its 12,000-char memo cap, a difference the plan missed), prompt parts, alerts (stock's), env, testing. Each engine keeps a thin same-named subclass at the old path, so call sites didn't change. Crypto alert change (6.3): icon prefixes on warn/error/critical titles, one retry on 429/5xx/network, "…" truncation, and a log line per alert, so the runbook's "0 warn/error lines" check now sees `alert:` lines. Snapshots unchanged; tests 998 → 998 (16 moved, 7 duplicates removed, 7 new). |
| 2026-10-27 02:25 PT | 6.5 (deploy pending 6.7) | `ControlPlane` (shared commands, kill switch, seed lifecycle, wording injected), `StatusReporter` (each bot keeps its `engine_status` field order), `EventCycleQueue` (stock: 30-min expiry + session gate; crypto: none, as before), `bootstrap` (both boot orders and shutdowns). A normalized before/after trace of events, logs and documents over 20+ commands, the queue and the seed paths was byte-identical. Crypto gained its first `engine.test.ts` (it passes on the old code too). Lines: crypto engine.ts 611 → 536 and main.ts 143 → 82; stock 806 → 724 and 158 → 95. Tests 998 → 1025. |
