# Architecture

This document explains how CryptoMarketBot is built and why: the deployment boundaries, data model, live stream, AI workflow, news engine, the one-time seed buy, risk model, evaluation, and the known limitations.

## Scope decisions

| Decision | Why |
| --- | --- |
| **Kraken spot, paper only** | Orders execute in a Kraken CLI paper workspace at live Kraken prices. Kraken has no self-service *spot* sandbox (Spot UAT is on request via an account manager; the self-service demo is Futures only), and the official CLI's paper wallet is the closest thing to a Kraken-hosted paper account. The engine has no live-trading code path and holds no exchange keys. |
| **No Polymarket** | Polymarket US has no paper/demo environment, so prediction markets were removed from scope. |
| **Grok via Vercel AI Gateway** | Same pattern as stockmarketbot: the `ai` SDK with plain `provider/model` ids and `AI_GATEWAY_API_KEY`; xAI's server-side `web_search` / `x_search` tools for research. Models are settings, so other gateway models can be configured for decisions (research needs a model with live search tools). |
| **Hosted MongoDB (Atlas)** | One cluster shared by the engine and the Vercel dashboard. No database container on the server. |
| **Monorepo (pnpm workspaces)** | `packages/core` holds everything both apps must agree on: settings schema, event schema, commands, DB types, metrics. |

## Components and boundaries

```
Browser ──https──▶ Vercel (Next.js dashboard) ──▶ MongoDB Atlas ◀── Engine (Docker, your server)
   │                                                                    │   ▲
   └──────── wss://engine.<domain>/v1/stream (via your reverse proxy) ──┘   │
                                                       Kraken public API ───┘ (WebSocket v2 + REST)
                                                       Vercel AI Gateway (Grok)
                                                       Kraken CLI (paper wallet, in the container)
                                                       ~70 free news sources (the wire, below)
                                                       Scraper sidecar (Docker, headless Chromium)
```

- **The engine owns trading state.** It is the only writer of positions, orders, fills and accounts, and a MongoDB lease guarantees a single running instance (a second engine waits; an engine that loses the lease stops).
- **The dashboard never trades.** It reads MongoDB and writes only commands, audit entries and owner sign-in records. Vercel's serverless runtime isn't asked to hold connections or run loops.
- **Control goes through MongoDB, not the network.** Commands are inserted by the dashboard and polled by the engine every second, validated twice (web and engine), audited, and answered with a result. The engine accepts no inbound control traffic, so exposing it through a proxy only exposes a read-only stream.
- **The engine doesn't depend on the dashboard.** Closed browsers, a Vercel outage or a broken proxy don't affect trading.

## Live stream design

The engine runs an authenticated WebSocket server (`/v1/stream`) plus `/healthz` and `/readyz`, published only on `127.0.0.1:8787`; your existing reverse proxy terminates TLS and forwards `wss://engine.<domain>` to it.

1. The browser asks the dashboard for a token (`/api/stream-token`): an HMAC-signed, 60-second token with `public` or `owner` scope (owner only with a valid owner session). The secret (`STREAM_TOKEN_SECRET`) is shared by Vercel and the engine.
2. The browser connects and sends the token **in the first frame** (never in the URL, so it can't land in proxy logs), with the last `seq` it saw.
3. The engine replays everything after that `seq` (from memory, falling back to MongoDB), then streams live. It pings every 15s; the client treats 45s of silence as a dead connection and reconnects with exponential backoff and jitter, fetching a fresh token each time.

Safety: browser `Origin` allowlist, max clients and max connections per IP, 4KB client frames, slow clients dropped, 12-hour session cap, public viewers never receive owner-only events (commands, errors, reconciliation details). Event content is engine-written summaries; anything from the web (titles, excerpts) is sanitized first, and the dashboard renders it as text.

**Events** are versioned (`v: 1`), typed (`EventDataMap` in `packages/core/src/events.ts`), and carry a strictly increasing `seq = max(last + 1, now_ms × 1000)`, which survives restarts without a database round trip per event. High-frequency events (tickers, heartbeats, memo progress) are streamed with `seq: 0` and not stored. Persisted events expire after `EVENT_RETENTION_DAYS`.

**Tradeoffs considered:** a tunnel (Cloudflare/Tailscale) would avoid touching the proxy but adds a dependency you don't need; a managed broker (Ably/Pusher) avoids any inbound exposure but adds a third party and message limits; SSE from Vercel would need long-running functions. Your reverse proxy + loopback-only binding + token auth is the simplest secure option.

## Data model (MongoDB)

| Collection | Contents | Retention |
| --- | --- | --- |
| `settings` | The single versioned settings document (risk, AI, schedule, strategies, universe) | permanent |
| `engine_state` | Desired state: running/paused/halted, kill switch | permanent |
| `engine_status` | Heartbeat: health of every dependency, data freshness, AI spend, resources | overwritten every 5s |
| `engine_lease` | Single-instance lease | 30s TTL |
| `events` | Persisted stream events (replay + history) | TTL, default 30 days |
| `commands` / `audit_log` | Owner commands and their results; every control and settings change | permanent |
| `accounts` / `positions` / `orders` / `fills` | The books. Fills are the source of truth; positions and the account are running totals that can be rebuilt from fills | permanent |
| `cycles` / `research` / `decisions` | Each cycle, its research memo + sources + queries, and every decision with evidence, costs, edge, size, all risk checks, execution, and later its scored outcome | permanent |
| `portfolio_snapshots` / `daily_stats` | Equity every 5 minutes; per-UTC-day P&L | 1 year / permanent |
| `ai_calls` | Every model call with tokens and cost (budget enforcement); research calls also count their searches, each one billed | permanent |
| `backtests` | Backtest runs and results | permanent |
| `wire_items` | Every stored news item: normalized text, symbols, category, tier, severity and its parts, cluster, confirmations, price when first seen, notable reasons | TTL, `wire.retention_days` (30) |
| `wire_triggers` | Every trigger candidate the policy produced, with the gate that passed or stopped it and why | TTL, `wire.retention_days` |
| `seed_runs` | The owner's one-time seed buys: schedule, status, allocations, orders, error | permanent |
| `notifications`, `login_attempts` | Alerts for the dashboard; sign-in rate limits (hashed IPs) | TTL |
| `auth_users` / `auth_sessions` / `auth_accounts` / `auth_verifications` | Owner sign-in (Better Auth magic links, only `OWNER_EMAIL`); written by the dashboard | sessions 12h, links 5 min (TTL) |

Raw market data is not stored: candles come from Kraken on demand (720 per interval) and only compact feature summaries reach MongoDB. Index definitions live in `packages/core/src/db.ts` and are created by the engine on boot.

## The paper wallet and reconciliation

Orders are market orders in the CLI workspace (`kraken paper buy|sell <pair> <volume> -o json`). The CLI fills buys at `ask × (1 + slippage)` and sells at `bid × (1 − slippage)` with `fee = cost × fee_rate`; the ledger uses exactly the same math. Around that the engine adds what a real desk needs:

- **Pre-trade price guard**: an order carries a limit; if the live WebSocket book is already worse, it isn't sent (immediate-or-cancel semantics).
- **Stops and targets**: the CLI has no stop orders, so the engine checks every open position against the live book every 3 seconds (stop: market sell; target: guarded sell). This runs regardless of pause, halt or AI state, and never on stale quotes.
- **Order lifecycle**: every order is written as `pending_submit` before the CLI runs. A CLI timeout makes the outcome *unknown*, never retried. Reconciliation matches unknown orders to wallet trades, imports wallet trades the books are missing, and compares USD and every coin balance. Any unexplained difference blocks new entries (exits keep working) until it's fixed or the wallet is reset.
- **Restarts**: on boot the engine re-acquires the lease, re-checks the wallet, reconciles, then resumes.

The CLI runs via `execFile` (no shell), with validated arguments, a minimal environment (none of the engine's secrets), strict serialization (the journal has one writer), and a timeout.

## AI workflow

```
features (code) → screens (code) → research (Grok + web/X search, streamed) → decision (Grok, structured)
   → edge & sizing (code) → risk engine (code) → paper wallet → outcome scoring (code, later)
```

- **Two calls per cycle**, and only when there's something to decide: research (never decides) and decision (never searches). This avoids expensive multi-agent loops.
- **Structured output** (`packages/crypto-core/src/report.ts`), validated with zod. On a schema failure: repair in code (string numbers, loose enums, prose around JSON), and if that loses decisions, retry with the exact validation error, at decreasing temperature. An optional fallback model is tried after outages, and at once after a timeout.
- **Normalization constrains the AI**: only listed symbols, only actions that fit the position state, numbers clamped, and only source URLs that research actually retrieved (anything else is dropped and the claim is downgraded to speculation).
- **Prompt-injection defense**: all retrieved content is fenced as `<untrusted>` data, with instructions never to follow it; fence-breaking sequences are neutralized; the decision model never has tools.
- **Calibration humility**: the AI gives `p_target_first`; code shrinks it halfway (configurable) toward the random-walk prior `stop / (stop + target)`, where the gross edge is exactly zero, then subtracts round-trip costs. Conviction is treated as a ranking, not a probability.
- **Defaults to no trade** when data is stale, research failed, the response can't be validated, or the daily AI budget is exhausted ($5/day by default; costs come from the gateway's reported cost, or a conservative estimate).
- **Visibility without chain-of-thought**: the dashboard shows search queries, sources, memo progress, structured decisions and risk checks, never hidden model reasoning.

## News engine (the wire)

The engine reads about 70 free news and market-data sources itself, so Grok doesn't have to find everything by searching, and so the bot can react to news between scheduled cycles.

```
sources (each isolated) → normalize → dedupe → tag symbols → classify → relevance filter
  → cluster (confirmations) → severity → notable flag → wire_items → policy → trigger gates
  → wire_triggers → event cycle (focused research + decision + risk engine, as always)
wire_items → dossier → every cycle's research and decision prompts
```

| Part | Code | What it does |
| --- | --- | --- |
| Catalog | `wire/catalog.ts`, `wire/sources/` | Every source: a generic kind (RSS, JSON, HTML, headless, Statuspage, Telegram channel preview, list diff) with a URL and interval, or a custom adapter for streams and multi-step APIs. Keyed sources stay off until their key is set. Tiers: 1 = primary or official, 2 = major outlets, 3 = aggregators and social |
| Poller, fetch, limiter | `wire/poller.ts`, `fetch.ts`, `limiter.ts` | One loop per source; its errors only change its own health. Conditional GETs (ETag / If-Modified-Since), one attempt per call, exponential backoff up to 30 min. Repeated 403/429 answers mark a source `degraded` and slow it right down. Per-domain token buckets; both bots share the server's IP, so shared limits (SEC, GDELT, StockTwits) are split between them |
| Pipeline | `wire/wire.ts`, `normalize.ts`, `cluster.ts`, `severity.ts`, `notable.ts` | Strips HTML and tracking parameters, dedupes, tags pairs, classifies, drops what's irrelevant, groups near-duplicates (title Jaccard ≥ 0.6 within 6 h; later copies from other domains are confirmations), scores severity 0–100, and flags what reaches the Live page |
| Lexicon | `wire/lexicon.ts` | Crypto language rules: which pair a headline names (ambiguous tickers such as SOL match only as `$SOL` or by name), category, direction, market-wide or not. Exploits are scored by the amount stolen |
| Market-data detectors | `wire/anomaly.ts`, `wire/metrics.ts` | Price, volume and market-wide shocks from closed 1-minute bars (z-scores, judged on the residual against BTC). `MetricWatcher` turns numeric feeds (funding, DVOL, fees, odds, attention, Coinbase premium) into items: level, change and spike rules, the first reading only a baseline, one item per excursion |
| Dossier | `wire/dossier.ts` | What our feeds know about a cycle's subjects: cluster roots ranked by severity × recency, capped per symbol, plus market-wide items, the next 72 h of scheduled releases (`calendar.ts`), and two gap lists (moves no item explains, high-severity items not yet confirmed) |
| Policy and gates | `wire/policy.ts`, `wire/trigger.ts` | The bot's rules turn an item into candidate triggers (review a holding, evaluate an entry, review the market); the shared gates decide and record why |
| Scraper sidecar | `apps/scraper` | Headless Chromium for the few pages that need JavaScript, shared by both engines. Its own container with no host port; the engine reaches it at `SCRAPER_URL` |

Files headed `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.` are identical in both repos apart from the `@cmb`/`@smb` import prefix. The catalog, lexicon, policy and `sources/` are per bot.

**Severity** keeps every part for the audit trail: the category base (or an adapter's own, e.g. a shock scaled by its z-score) × a tier factor, +20 if it names a holding (+8 for a candidate or universe pair, +5 market-wide), +8 per extra independent domain up to +16, and points for a matching price or volume anomaly within ±15 min. The thresholds (`wire.thresholds`, defaults 30 / 55 / 70 / 85) mean: annotate the dossier, review a holding, evaluate an entry, critical.

**Trigger gates**, in order: `wire.mode` → fresh (first seen within `trigger_max_age_minutes`, never a source's first poll after a restart, published under 2 h ago) → confirmation for entries (a tier-1 source, two independent outlets, or a matching price move) → shadow mode → engine running and kill switch off → per-symbol cooldown → hourly and daily caps → AI budget. A trigger never trades: it asks for a focused event cycle, where Grok and the risk engine decide as usual. Event cycles are spaced by `event_min_gap_seconds`, and `event_budget_reserve_pct` of the daily AI budget is kept for them. The one exception is `emergency_action` for a holding hit by a critical, confirmed, negative event, and it only ever reduces risk.

An unexplained move (a price shock no news explains) in a held pair asks for a review. In a universe pair we don't hold, it asks for an entry check only when `unexplained_move_entries` is on (off by default: on 2026-10-27, 13 of these checks cost $1.91 and none led to a trade).

**Research modes** (`wire.research_mode`):

| Mode | What Grok research does |
| --- | --- |
| `full` | The usual research; the dossier goes into the decision prompt. Also used whenever the wire is off or unhealthy (fewer than half its sources `ok`) |
| `gap_fill` | A shorter prompt that gets the dossier and only fills its gaps: X sentiment, unexplained moves, unconfirmed items, anything critical it missed |
| `auto` | `gap_fill`, but skipped when there's no gap: no unexplained moves, no unconfirmed items, and an X read of the same subjects within 2 h. The cycle records why. In practice it never skipped: on 2026-10-27 every scheduled cycle ran the gap-fill |
| `held_gaps` (default) | The dossier alone, and `gap_fill` only when a held pair under review has an unexplained move or an unconfirmed high-severity item (no X-freshness rule). The cycle records why it skipped |

**Settings** (the `wire` section, changed live from Admin; defaults): `mode` live, `research_mode` held_gaps, `thresholds` 30/55/70/85, `entry_confirmation` on, `unexplained_move_entries` off, `trigger_max_age_minutes` 15, `symbol_cooldown_minutes` 30, `event_min_gap_seconds` 60, `max_event_cycles_per_hour` / `_per_day` 4 / 24, `event_budget_reserve_pct` 30, `event_research` x_verify (45 s; event decisions 90 s), `emergency_action` review, `anomaly` price z 4 / volume ×5 / market z 4, `retention_days` 30, and the crypto detectors: `depeg_pct` 1, `tvl_drop_pct` 15, `odds_swing_pts` 15, `funding_extreme_annual_pct` 100, `coinbase_premium_pct` 0.3.

**Events and commands**: `wire.item`, `wire.notable`, `wire.dossier`, `wire.trigger` and `wire.source` on the live stream; `wire.replay` (Admin) re-runs an item through the policy as a dry run. Source health is in the heartbeat (`engine_status.wire.sources`: state, last error, items and drops in 24 h, lag).

**Failure behavior**: the wire never throws into the engine. A broken source, a bad payload or a database hiccup costs at most that batch of items, and trading goes on as it would without the wire. On boot the cluster index and seen ids are rebuilt from MongoDB, and nothing from a source's first poll can trigger, so a restart never replays old news as new. A dead scraper sidecar only takes the headless sources down. Settings change live from Admin (`wire.mode: off` turns the whole engine off; `disabled_sources` turns single sources off).

## One-time seed buy

The owner can put a dollar amount into long-term core holdings at a set time (Admin → One-time seed, the `seed.schedule` and `seed.cancel` commands).

```
scheduled ──(due, engine running)──▶ running ──▶ done | failed
    │ └──(not started within 2 h)──▶ failed ("missed")
    └──(seed.cancel)──▶ canceled
```

- **What it buys**: features → every fresh, unheld universe pair with daily-trend levels → full Grok research (long-term outlook, macro, flows) → a structured allocation of 1–4 pairs → each sized at amount × weight → the normal risk engine → execution. The positions are ordinary `daily_trend` positions afterwards.
- **Risk**: the seed is owner-directed, so the conviction, edge and reward:risk gates don't apply; every other gate and cap does. The caps resize rather than reject, so a seed bigger than the per-position or per-strategy caps allow is trimmed, and Grok is told the limits so it splits the amount accordingly.
- **Once**: only one run can be scheduled or running, and a new one is refused while any run is `done` unless the command sets `force`. A run is a single attempt: a failure is alerted (Discord and the dashboard) and never retried. `seed.started` and `seed.completed` go on the live stream.

## Strategies

Trend following, mean reversion, relative strength, event-driven shocks, plus on-demand evaluation (owner asks the AI about a pair). Each states its economic rationale and how it's evaluated (`packages/core/src/strategies.ts`, shown on the Strategies page). Strategies only *propose*; the AI decides; the risk engine disposes. Each can be enabled/disabled and capped per strategy.

## Risk model

Deterministic and pure (`apps/engine/src/risk/engine.ts`), every check recorded on the decision:

- **Gates** (reject): engine running, kill switch off, venue online, books reconciled, daily loss, drawdown, fresh quote, spread, strategy enabled, not already held, max positions, trades per day, re-entry cooldown, conviction, net edge after costs, reward:risk, stop distance band, target above price, limit price sanity.
- **Caps** (resize down): max position, per-asset, total exposure, correlated exposure (14-day hourly return correlation; unknown counts as correlated), per-strategy exposure, cash. Then Kraken lot size and minimums.
- **Exits** are risk-reducing and allowed while paused/halted; only AI-discretionary exits wait for the minimum hold (anti-churn). Stops on a held position only ever move up.
- **Kill switch**: blocks all new orders immediately; optional liquidation; releasing it leaves the engine paused until you resume. Max drawdown engages it automatically.

## Is there an edge? How it's measured

- **Backtests** (`apps/engine/src/backtest`) replay the deterministic screens bar by bar: features use only closed candles, entries fill at the next bar's open plus slippage and fees, stops/targets use worst-case ordering within a bar, and a 72h time stop applies. In-sample and out-of-sample are reported separately, with buy-and-hold BTC and equal-weight benchmarks. The AI is deliberately **not** backtested: a model asked about past bars has probably seen what happened next.
- **Forward evaluation**: every decision (including no-trades) is scored after its horizon. The Analytics page compares what the AI bought vs. what it skipped vs. the screen alone, the hit rate by action, the Brier score of the AI's probability vs. the shrunk estimate vs. the random-walk prior, and results by model/prompt version.
- **No automatic learning**: nothing changes strategies or prompts based on results. Prompt and settings versions are stored on every decision so changes can be compared deliberately.

## Testing

Automated tests (173 in the engine alone): core schemas and metrics; the news engine (every source parser against trimmed real payloads, the pipeline, clustering, severity, the dossier, trigger gates and policy, the anomaly and metric detectors, the headless client); the seed run; Kraken book checksum against Kraken's documented example; the CLI wrapper against the CLI's pinned JSON shapes; the risk engine and sizing; AI normalization, repair and the runner (mocked SDK); the ledger and every reconciliation path against an in-memory MongoDB and a simulated wallet; the event bus; command expiry; the WebSocket server over real sockets; backtest look-ahead; outcome scoring; sanitizing and secret scrubbing. A local end-to-end run (engine + dashboard + MongoDB + live Kraken data) verified pages, login, commands, stream auth/visibility/replay, paper reset, graceful shutdown and restart recovery.

## Known limitations and risks

- **The real Kraken CLI binary hasn't run against this code yet** (the wrapper was built from the CLI's source and pinned output shapes, and tested with a simulated wallet). The server checklist validates it first.
- **Paper fills are optimistic in places**: the CLI fills at the top of the ticker with flat slippage (no depth, no partial fills). The engine's edge math uses the real order book to estimate slippage, so costs are counted conservatively, but realized paper P&L can still be better than live trading would be.
- **Stops depend on the engine running.** If the container is down, positions aren't monitored (the CLI has no resting stops). Docker restarts it automatically; extended downtime is the risk.
- **Kraken's 720-candle limit** caps backtest history (30 days of 1h, 120 days of 4h, ~2 years of daily) unless you supply Kraken's downloadable OHLCVT CSVs.
- **LLM behavior can change** with model updates; that's why decisions record model and prompt versions, and why the AI never bypasses the risk engine.
- **Free news sources can change or vanish.** Several are unofficial (ForexFactory's calendar, Telegram channel previews, scraped pages), and some rate-limit the shared IP (GDELT answers 429 most of the time and runs degraded). Each failure only degrades that source, and the heartbeat shows it, but coverage can thin out without any code change.
