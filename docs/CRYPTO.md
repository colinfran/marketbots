# Architecture

This document explains how CryptoMarketBot is built and why: the deployment boundaries, data model, live stream, the agent, news engine, risk model, evaluation, and the known limitations.

## Scope decisions

| Decision | Why |
| --- | --- |
| **Kraken spot, paper only** | Orders execute in a Kraken CLI paper workspace at live Kraken prices. Kraken has no self-service *spot* sandbox (Spot UAT is on request via an account manager; the self-service demo is Futures only), and the official CLI's paper wallet is the closest thing to a Kraken-hosted paper account. The engine has no live-trading code path and holds no exchange keys. |
| **No Polymarket** | Polymarket US has no paper/demo environment, so prediction markets were removed from scope. |
| **A local model** | Qwen 3.6 35B-A3B on the server's two GPUs (llama.cpp), as `local/qwen3.6-35b-a3b-q2`, through llama.cpp's OpenAI-compatible API: no outside AI service, no key, no cost. The agent runs on it, and researches through our own search service and scraper, without X ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)). Grok, through Vercel AI Gateway, did both until 2026-10-28. |
| **Hosted MongoDB (Azure DocumentDB)** | One cluster shared by the engine and the Vercel dashboard. No database container on the server. |
| **Monorepo (pnpm workspaces)** | `packages/core` holds everything both apps must agree on: settings schema, event schema, commands, DB types, metrics. |

## Components and boundaries

```
Browser ─https─▶ Vercel (Next.js dashboard) ─▶ Azure DocumentDB ◀── Engine (Docker, your server)
   │                                                                    │   ▲
   └──────── wss://engine.<domain>/v1/stream (via your reverse proxy) ──┘   │
                                                       Kraken public API ───┘ (WebSocket v2 + REST)
                                                       Local model server (llm) + search service (search)
                                                       Kraken CLI (paper wallet, in the container)
                                                       ~70 free news sources (the wire, below)
                                                       Scraper sidecar (Docker, headless Chromium)
```

- **The engine owns trading state.** It is the only writer of positions, orders, fills and accounts, and a MongoDB lease guarantees a single running instance (a second engine waits; an engine that loses the lease stops).
- **The dashboard never trades.** It reads MongoDB and writes only commands, audit entries and owner sign-in records. Vercel's serverless runtime isn't asked to hold connections or run loops.
- **Control goes straight to the engine, signed.** The dashboard's server sends each command to the engine's `POST /v1/commands`, signed with the stream secret (an HMAC with crypto's `cmb-request.` prefix over the method, path, a millisecond timestamp and the body; a minute of clock tolerance). The engine validates it again (web and engine), runs it at once, one at a time, and answers with a result the page polls (`GET /v1/commands/<id>`); every command is audited. When the engine can't be reached, the dashboard queues the command in MongoDB under the same id instead, and the engine runs it within 3 seconds of being back (never twice). So the secret now authorizes commands as well as the owner stream: it stays in `.env` and on Vercel only. (Until 2026-10-31 every command went through MongoDB, polled every second.)
- **Pause and the kill switch never wait on the database.** They take effect in the engine first and are saved after, retried until MongoDB takes them (and once more at shutdown); so do the engine's own halts and the agent's breakers. Resume and releasing the kill switch are saved first: if MongoDB fails, the engine stays paused.
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
| `settings` | The single versioned settings document (risk, the agent, strategies, universe, the wire) | permanent |
| `engine_state` | Desired state: running/paused/halted, kill switch; when the agent was last turned on or resumed, and any breaker pause on its entries | permanent |
| `engine_status` | Heartbeat: health of every dependency, data freshness, AI calls today, resources (`engine`); the large sections, news-source health and per-pair prices and indicators (`detail`). The dashboard reads the two as one | `engine` overwritten every 5s (its error, AI-call and trigger counts read once a minute), `detail` every minute |
| `engine_lease` | Single-instance lease | 30s TTL |
| `events` | Persisted stream events (replay + history) | TTL, default 30 days |
| `commands` / `audit_log` | Owner commands and their results; every control and settings change | permanent |
| `accounts` / `positions` / `orders` / `fills` | The books. Fills are the source of truth; positions and the account are running totals that can be rebuilt from fills | permanent |
| `decisions` | Every decision with evidence, costs, edge, size, all risk checks, execution, the agent episode that made it, and later its scored outcome | permanent |
| `portfolio_snapshots` / `daily_stats` | Equity every 5 minutes; per-UTC-day P&L | 1 year / permanent |
| `ai_calls` | Every model call: task, model, tokens, time and outcome; research calls also count their searches. Costs are 0 since the local model (before 2026-10-28, Grok's billed cost) | permanent |
| `search_usage` | What research's metered search providers cost this bot each UTC month (one document a month), for their pacing ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)); the agent's research uses only the free engines | permanent |
| `wire_items` | Every stored news item: normalized text, symbols, category, tier, severity and its parts, cluster, confirmations, price when first seen, notable reasons | TTL, `wire.retention_days` (30) |
| `wire_triggers` | Every trigger candidate the policy produced, with the gate that passed or stopped it and why | TTL, `wire.retention_days` |
| `agent_episodes` | Each agent episode: what woke it, the brief, every step (tool, arguments, result, thinking, tokens), the answer and what became of each decision, watch and note. Long text is capped here; the history store keeps the full record | 14 days (TTL) |
| `agent_watches` / `agent_notes` | The agent's watches (active until they fire or expire) and its notes per subject | removed 30 days after a watch ends; notes 14 days (TTL) |
| `notifications`, `login_attempts` | Alerts for the dashboard; sign-in rate limits (hashed IPs) | TTL |
| `auth_users` / `auth_sessions` / `auth_accounts` / `auth_verifications` | Owner sign-in (Better Auth magic links, or emailed codes in the Home Screen app; only `OWNER_EMAIL`); written by the dashboard | sessions 30 days, links and codes 5 min (TTL) |

The timed cycles' collections (`cycles`, `research`, `backtests`, `seed_runs`) and the old shadow book (`shadow_positions`, `shadow_fills`) are no longer written or shown; their documents stay in MongoDB.

Raw market data is not stored: candles come from Kraken on demand (720 per interval) and only compact feature summaries reach MongoDB. Index definitions live in `packages/core/src/db.ts` and are created by the engine on boot.

## The paper wallet and reconciliation

Orders are market orders in the CLI workspace (`kraken paper buy|sell <pair> <volume> -o json`). The CLI fills buys at `ask × (1 + slippage)` and sells at `bid × (1 − slippage)` with `fee = cost × fee_rate`; the ledger uses exactly the same math. Around that the engine adds what a real desk needs:

- **Pre-trade price guard**: an order carries a limit; if the live WebSocket book is already worse, it isn't sent (immediate-or-cancel semantics).
- **Stops and targets**: the CLI has no stop orders, so the engine checks every open position against the live book every 3 seconds (stop: market sell; target: guarded sell). This runs regardless of pause, halt or AI state, and never on stale quotes.
- **Order lifecycle**: every order is written as `pending_submit` before the CLI runs. A CLI timeout makes the outcome *unknown*, never retried. Reconciliation matches unknown orders to wallet trades, imports wallet trades the books are missing, and compares USD and every coin balance. Any unexplained difference blocks new entries (exits keep working) until it's fixed or the wallet is reset.
- **Restarts**: on boot the engine re-acquires the lease, re-checks the wallet, reconciles, then resumes.

The CLI runs via `execFile` (no shell), with validated arguments, a minimal environment (none of the engine's secrets), strict serialization (the journal has one writer), and a timeout.

## The agent

An agent on the local model is the only thing that decides ([plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent), `@mb/agent` and `src/agent/`). Code watches everything all the time and wakes it when something matters; in each wake-up (an *episode*) it looks things up one step at a time and decides. There are no timed cycles. Its level is `agent.level` in Admin:

- **on** (the default): it trades the paper wallet through the bot's own sizing, risk engine and executor, inside its envelope.
- **off**: nothing decides. Protection (stops and targets every 3 s), marks, reconciliation, the drawdown halt and outcome scoring run either way.

**What wakes it** (observations, scored in code and queued per subject: a burst waits 2–10 s to become one wake-up, risk before opportunity before review, and a subject that woke it waits `agent.wake_cooldown_minutes` unless its salience rises 15 points, a P0, its own watch or the owner):

| Source | Priority |
| --- | --- |
| News: every trigger candidate that passes the wire's gates on the item itself (fresh, not old news, confirmed for entries) | P0 bad news on a holding (or a critical market review while it holds anything), P1 entry ideas, P2 the rest |
| The screens, once each minute's bars arrive from Kraken (every 10 minutes while none come), with an interval's candles fetched afresh just after it closes. The best five viable setups on pairs it doesn't hold wake it together, as one market-wide wake-up with a SUBJECT section per pair; a setup is asked about again after 2 h (daily trend: 24 h), and none comes while the envelope refuses entries | P1 |
| A held pair moving `schedule.trigger_move_atr` 1 h ATRs since its last review (checked every 3 s), again at every further ATR | P0 down, P2 up |
| A stop or target the protection loop hits | P2 |
| A macro release 15 minutes out | P2 |
| Its own watches (price above or below, a % move, news at a severity, a time) | the watch's |
| A quiet-time review once nothing has woken it for `agent.sweep_minutes` (2 h) | P2 |
| The owner's question (Agent page) | P2, read-only |
| The owner's *Wake the agent* (`agent.review`, optionally about up to 5 pairs) | P1 |

**An episode**: a short brief (why it woke, its book and the limits in force, the market, a SUBJECT section per pair it woke for with its latest 3 news items from the last 24 h (or a line saying there are none), its notes and watches), then steps. Each step is one JSON object under a grammar: a call to one of its tools, or the answer (the decision schema in `packages/crypto-core/src/report.ts`, plus the entry's strategy, watches, notes and a reply). The tools are read-only: `book`, `quote`, `features`, `depth`, `news`, `dossier`, `item`, `past_decisions`, `calendar`, from the history store `history` and `past_news`, and for P2 and P3 episodes `research`: web research on one question, on the search service's free engines only, 1–3 minutes, returning a memo with its sources. Limits per priority (`agent.limits`): P0 4 steps / 60 s, P1 6 / 120 s, both without thinking; P2 8 / 240 s and P3 12 / 600 s with 1k and 2k tokens of thinking. Tool calls stop at 60% of the time; the last step may only answer. One episode runs at a time; a P0 aborts a running P1–P3.

**Its decisions** are normalized (`normalizeCryptoDecision`: only listed pairs, only actions that fit the position state, numbers clamped, only source URLs a tool actually returned), exits first: one per pair, any number about pairs it holds (it manages the whole book) and at most 3 about pairs it doesn't. An entry passes the **envelope** (`agent.envelope`: 4 entries a day, 2 an hour, 4 open positions it opened, one action per pair per 30 min, no re-entry 24 h after a stop-out or 6 h after an exit; an hour whose commitment budget, 10% of equity, has less than 1% of equity left refuses entries), and its stop is moved just inside the allowed range when it lands outside it. Then every decision goes through `processDecision` (sizing, `evaluateCryptoEntry` against the paper wallet's account and gate, the executor, the ledger), with its size at the envelope's share and capped by the hour's budget. Each is a `decisions` record with `trigger_kind: "agent"` and `agent_episode_id` set, scored after its horizon. Buys and exits post to Discord, linking the episode. Every position in the wallet is its to manage; the envelope's open-position limit counts only the ones it opened. Exits obey only the minimum hold, and stops only move up.

- **Calibration humility**: the agent gives `p_target_first`; code shrinks it halfway (configurable) toward the random-walk prior `stop / (stop + target)`, where the gross edge is exactly zero, then subtracts round-trip costs. Conviction is treated as a ranking, not a probability.
- **Prompt-injection defense**: everything from the web or the news is fenced as `<untrusted>` data, with instructions never to follow it; fence-breaking sequences are neutralized. Its tools only read; only its answer acts, through the risk engine.
- **No trade by default** when data is stale or the answer can't be validated.

**Circuit breakers** (5 risk rejections in a row, most entries refused in an hour, over 10% invalid answers, 3 envelope refusals a day, the account down 3% in a day or 6% since the agent was turned on or last resumed, a slow model): a trip **pauses its new entries** until the owner resumes them (Agent page, `agent.resume_entries`, audited); exits, stops and targets go on. The pause and its reason are kept in the engine's state (`agent_pause`) across restarts, and a trip is alerted. A slow model only pauses its entries until the model is fast again.

**Where to see it**: the Agent page (the model's live feed: every call's thinking and answer as it streams, once a second, and which of the server's slots are busy; the episode as it runs, its watches and notes, every episode, the owner's *Ask the agent* and *Wake the agent*), the Live page (the same feed), the decision pages (an agent decision links its episode), and the heartbeat's `agent` block. Thinking streams to the owner only, unless `agent.public_thinking`.

## News engine (the wire)

The engine reads about 70 free news and market-data sources itself, so the AI doesn't have to find everything by searching, and so the agent hears about news as it happens.

```
sources (each isolated) → normalize → dedupe → tag symbols → classify → relevance filter
  → cluster (confirmations) → severity → notable flag → wire_items → policy → trigger gates
  → wire_triggers → the agent (an observation: it wakes, looks things up, decides; the risk engine as always)
wire_items → dossier → the agent's brief and its news and dossier tools
```

| Part | Code | What it does |
| --- | --- | --- |
| Catalog | `wire/catalog.ts`, `wire/sources/` | Every source: a generic kind (RSS, JSON, HTML, headless, Statuspage, Telegram channel preview, list diff) with a URL and interval, or a custom adapter for streams and multi-step APIs. Keyed sources stay off until their key is set. Tiers: 1 = primary or official, 2 = major outlets, 3 = aggregators and social |
| Poller, fetch, limiter | `wire/poller.ts`, `fetch.ts`, `limiter.ts` | One loop per source; its errors only change its own health. Conditional GETs (ETag / If-Modified-Since), one attempt per call, exponential backoff up to 30 min. Repeated 403/429 answers mark a source `degraded` and slow it right down. Per-domain token buckets; both bots share the server's IP, so shared limits (SEC, GDELT, StockTwits) are split between them |
| Pipeline | `wire/wire.ts`, `normalize.ts`, `cluster.ts`, `severity.ts`, `notable.ts` | Strips HTML and tracking parameters, dedupes, tags pairs, classifies, drops what's irrelevant, groups near-duplicates (title Jaccard ≥ 0.6 within 6 h; later copies from other domains are confirmations), scores severity 0–100, and flags what reaches the Live page |
| Lexicon | `wire/lexicon.ts` | Crypto language rules: which pair a headline names (ambiguous tickers such as SOL match only as `$SOL` or by name), category, direction, market-wide or not. Exploits are scored by the amount stolen |
| Market-data detectors | `wire/anomaly.ts`, `wire/metrics.ts` | Price, volume and market-wide shocks from closed 1-minute bars (z-scores, judged on the residual against BTC). `MetricWatcher` turns numeric feeds (funding, DVOL, fees, odds, attention, Coinbase premium) into items: level, change and spike rules, the first reading only a baseline, one item per excursion |
| Dossier | `wire/dossier.ts` | What our feeds know about an episode's subjects: cluster roots ranked by severity × recency, capped per symbol, plus market-wide items, the next 72 h of scheduled releases (`calendar.ts`), and two gap lists (moves no item explains, high-severity items not yet confirmed) |
| Policy and gates | `wire/policy.ts`, `wire/trigger.ts` | The bot's rules turn an item into candidate triggers (review a holding, evaluate an entry, review the market); the shared gates decide and record why |
| Scraper sidecar | `apps/scraper` | Headless Chromium for the few pages that need JavaScript, shared by both engines. Its own container with no host port; the engine reaches it at `SCRAPER_URL` |

Files headed `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.` are identical in both repos apart from the `@cmb`/`@smb` import prefix. The catalog, lexicon, policy and `sources/` are per bot.

**Severity** keeps every part for the audit trail: the category base (or an adapter's own, e.g. a shock scaled by its z-score) × a tier factor, +20 if it names a holding (+8 for a candidate or universe pair, +5 market-wide), +8 per extra independent domain up to +16, and points for a matching price or volume anomaly within ±15 min. The thresholds (`wire.thresholds`, defaults 30 / 55 / 70 / 85) mean: annotate the dossier, review a holding, evaluate an entry, critical.

**Trigger gates**: the agent hears about every candidate that passes the gates on the item itself: `wire.mode` → fresh (first seen within `trigger_max_age_minutes`, never a source's first poll after a restart, published under 2 h ago) → confirmation for entries (a tier-1 source, two independent outlets, or a matching price move). The rest of the gates decide only the trigger's record, its alerts and the emergency exit: shadow mode (logged, no alert or emergency action) → engine running and kill switch off → per-symbol cooldown → hourly and daily caps. A trigger never trades by itself; the agent decides through the risk engine as usual. The one exception is `emergency_action` for a holding hit by a critical, confirmed, negative event, and it only ever reduces risk.

An unexplained move (a price shock no news explains) in a held pair asks for a review. In a universe pair we don't hold, it asks for an entry check only when `unexplained_move_entries` is on (off by default: on 2026-10-27, 13 of these checks cost $1.91 and none led to a trade).

The timed cycles' research modes and event-cycle timings are gone with the cycles; the agent researches with its `research` tool when its own sources don't answer a question.

**Settings** (the `wire` section, changed live from Admin; defaults): `mode` live, `thresholds` 30/55/70/85, `entry_confirmation` on, `unexplained_move_entries` off, `trigger_max_age_minutes` 15, `symbol_cooldown_minutes` 30, `max_event_cycles_per_hour` / `_per_day` 4 / 24 (the trigger caps), `emergency_action` review, `anomaly` price z 4 / volume ×5 / market z 4, `retention_days` 30, and the crypto detectors: `depeg_pct` 1, `tvl_drop_pct` 15, `odds_swing_pts` 15, `funding_extreme_annual_pct` 100, `coinbase_premium_pct` 0.3.

**Events and commands**: `wire.item`, `wire.notable`, `wire.dossier`, `wire.trigger` and `wire.source` on the live stream; `wire.replay` (Admin) re-runs an item through the policy as a dry run. Source health is in the heartbeat (`wire.sources` in `engine_status`'s `detail` document, rewritten once a minute: state, last error, items and drops in 24 h, lag).

**Failure behavior**: the wire never throws into the engine. A broken source, a bad payload or a database hiccup costs at most that batch of items, and trading goes on as it would without the wire. On boot the cluster index and seen ids are rebuilt from MongoDB, and nothing from a source's first poll can trigger, so a restart never replays old news as new. A dead scraper sidecar only takes the headless sources down. Settings change live from Admin (`wire.mode: off` turns the whole engine off; `disabled_sources` turns single sources off).

## Strategies

Trend following, mean reversion, relative strength and event-driven shocks. Each states its economic rationale (`packages/crypto-core/src/strategies.ts`). Strategies only *propose*: their screens wake the agent with setups, the agent decides, and the risk engine disposes. Each can be enabled or disabled and capped per strategy (Admin → Strategies).

Not every setup a screen finds is worth the agent's time. A setup whose own stop and target can't pass the risk engine (reward:risk under `min_reward_risk`, or a target too close to beat the estimated round trip by `min_edge_bps` even at the highest probability the engine allows) doesn't wake it, and one it was asked about recently waits: a day for daily-trend setups, which only change with a new daily candle, and 2 hours for the others.

## Risk model

Deterministic and pure (`apps/engine/src/risk/engine.ts`), every check recorded on the decision:

- **Gates** (reject): engine running, kill switch off, venue online, books reconciled, daily loss, drawdown, fresh quote, spread, strategy enabled, not already held, max positions, trades per day, re-entry cooldown, conviction, net edge after costs, reward:risk, stop distance band, target above price, limit price sanity.
- **Caps** (resize down): max position, per-asset, total exposure, correlated exposure (14-day hourly return correlation; unknown counts as correlated), per-strategy exposure, cash. Then Kraken lot size and minimums.
- **Exits** are risk-reducing and allowed while paused/halted; only AI-discretionary exits wait for the minimum hold (anti-churn). Stops on a held position only ever move up.
- **Kill switch**: blocks all new orders immediately; optional liquidation; releasing it leaves the engine paused until you resume. Max drawdown engages it automatically.

## Is there an edge? How it's measured

- **Forward evaluation**: every decision (including no-trades) is scored after its horizon. The Analytics page shows the results; the Journal, each day's decisions and what came of them.
- **No automatic learning**: nothing changes strategies or prompts based on results. Prompt and settings versions are stored on every decision so changes can be compared deliberately.

## Testing

Automated tests (210 in the engine alone): core schemas and metrics; the news engine (every source parser against trimmed real payloads, the pipeline, clustering, severity, the dossier, trigger gates and policy, the anomaly and metric detectors, the headless client); the agent (its tools, envelope, breakers and decisions); Kraken book checksum against Kraken's documented example; the CLI wrapper against the CLI's pinned JSON shapes; the risk engine and sizing; decision normalization; the ledger and every reconciliation path against an in-memory MongoDB and a simulated wallet; the event bus; command expiry; the WebSocket server over real sockets; the live model feed; outcome scoring; sanitizing and secret scrubbing. A local end-to-end run (engine + dashboard + MongoDB + live Kraken data) verified pages, login, commands, stream auth/visibility/replay, paper reset, graceful shutdown and restart recovery.

## Known limitations and risks

- **The real Kraken CLI binary hasn't run against this code yet** (the wrapper was built from the CLI's source and pinned output shapes, and tested with a simulated wallet). The server checklist validates it first.
- **Paper fills are optimistic in places**: the CLI fills at the top of the ticker with flat slippage (no depth, no partial fills). The engine's edge math uses the real order book to estimate slippage, so costs are counted conservatively, but realized paper P&L can still be better than live trading would be.
- **Stops depend on the engine running.** If the container is down, positions aren't monitored (the CLI has no resting stops). Docker restarts it automatically; extended downtime is the risk.
- **Kraken's 720-candle limit** caps what the screens see at once (30 days of 1h, 120 days of 4h, ~2 years of daily); the history store keeps the 1-minute bars beyond it.
- **LLM behavior can change** with model updates; that's why decisions record model and prompt versions, and why the AI never bypasses the risk engine.
- **The agent shares the model server** with the stock bot's agent and the article summaries (three slots). Busy hours slow every call; the Agent page shows its speed, and a slow model trips a recorded breaker.
- **Free news sources can change or vanish.** Several are unofficial (ForexFactory's calendar, Telegram channel previews, scraped pages), and some rate-limit the shared IP (GDELT answers 429 most of the time and runs degraded). Each failure only degrades that source, and the heartbeat shows it, but coverage can thin out without any code change.
