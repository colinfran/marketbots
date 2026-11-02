# Architecture

How StockMarketBot is built and why: the deployment boundaries, the engine's loops, the agent, the news engine and its price layers, the live stream, options, the data model, and the known limitations. The design follows CryptoMarketBot's (an always-on engine and a read-only dashboard); the trading logic is StockMarketBot's own.

## Scope decisions

| Decision | Why |
| --- | --- |
| **Engine + dashboard split** | The bot used to run inside Vercel functions triggered by an external cron, with a 300-second limit per run. An always-on engine has no time limit, keeps WebSocket connections to Alpaca, watches options exits every few seconds, and streams its work to the dashboard as it happens. |
| **Alpaca paper only** | Trading always goes to `paper-api.alpaca.markets`; there is no live-trading code path. Only the engine holds the keys. |
| **Defined-risk options only** | Long calls, long puts, call/put debit spreads. The most any position can lose is what was paid, so there are no margin calls, a spread's short leg is always covered by its long leg, and engine downtime can't turn into an unbounded loss. |
| **A local model** | Qwen 3.6 35B-A3B on the server's two GPUs (llama.cpp), as `local/qwen3.6-35b-a3b-q2`, through llama.cpp's OpenAI-compatible API: no outside AI service, no key, no cost. The agent runs on it, and researches through our own search service and scraper, without X ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)). Grok, through Vercel AI Gateway, did both until 2026-10-28. |
| **MongoDB (Azure DocumentDB)** | One database shared by the engine (the only writer of trading state) and the Vercel dashboard. |
| **Monorepo (pnpm workspaces)** | `packages/core` holds what both apps must agree on: settings, events, commands, document types, the report schema, options helpers, FIFO P&L. |

## Components and boundaries

```
Browser ─https─▶ Vercel (Next.js dashboard) ─▶ Azure DocumentDB ◀── Engine (Docker, your server)
   │                                                                   │  ▲  ▲
   └──────── wss://engine.stockmarketbot.app/v1/stream (reverse proxy) ─┘  │  │
                                       Alpaca paper: REST, trade_updates WS, IEX data WS
                                       Local model server (llm) + search service (search)
                                       ~80 free news and price sources (the wire, below)
                                       Scraper sidecar (Docker, headless Chromium)
```

- **The engine owns trading.** It is the only process that talks to Alpaca or the model server. A MongoDB lease guarantees a single running instance.
- **The dashboard never trades and holds no broker keys.** It reads MongoDB (including the account, equity history and chart bars the engine copies into the `cache` collection) and writes only commands, audit entries and owner sign-in records.
- **Control goes straight to the engine, signed.** The dashboard's server sends each command to the engine's `POST /v1/commands`, signed with the stream secret (an HMAC with stock's `smb-request.` prefix over the method, path, a millisecond timestamp and the body; a minute of clock tolerance). The engine validates it again, runs it at once, one at a time, and answers with a result the page polls (`GET /v1/commands/<id>`); every command is audited. When the engine can't be reached, the dashboard queues the command in MongoDB under the same id instead, and the engine runs it within 3 seconds of being back (never twice). So the secret now authorizes commands as well as the owner stream: it stays in `.env` and on Vercel only. (Until 2026-10-31 every command went through MongoDB, polled every second.)
- **Pause and the kill switch never wait on the database.** They take effect in the engine first and are saved after, retried until MongoDB takes them (and once more at shutdown); so do the agent's breakers. Resume and releasing the kill switch are saved first: if MongoDB fails, the engine stays paused.
- **Stocks don't depend on the engine to be protected.** Every buy is a bracket order and every held position gets an OCO pair, all resting at Alpaca. Options exits do need the engine (Alpaca has no bracket orders for options), which is why options are limited to defined risk.

## The engine's loops

| Every | Job |
| --- | --- |
| 3 s | the command queue in MongoDB (commands sent while the engine couldn't be reached; the others arrive directly) |
| 10 s | heartbeat to `engine_status` (the Admin page) and the stream; its large news-source health section once a minute, in its own document |
| 15 s | account snapshot for the dashboard; live-price subscriptions; periodic summary |
| `options.monitor_seconds` (15) | options monitor: marks every position, checks its exits, closes what's hit |
| 30 s | the market calendar: today's session |
| 60 s (15 min off-hours) | maintenance: order sync, the daily loss limit, stock protection, the overnight rules in the last 7 minutes of the session, options reconciliation, and after the close (`schedule.postmarket_delay_minutes`) the day's record. While an agent episode runs, it only syncs orders |
| 5 / 60 min | equity history and chart bars for the website |
| continuous | the news engine: each source on its own interval or stream (below) |
| 1 s | the agent: its observations, watches and the next episode (below) |
| daily, before premarket | the scan universe for the news engine's price layers |

Fills arrive instantly over Alpaca's `trade_updates` stream (binary JSON frames on paper). The REST sync still runs every minute, so a dropped connection never loses a fill. Market data comes from the IEX stream (the free plan allows one connection and 30 symbols, so the engine subscribes to held stocks, option underlyings, SPY/QQQ and then what the agent watches).

## The agent

An agent on the local model is the only thing that decides ([plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent), `@mb/agent` and `src/agent/`). Code watches the session, prices, the setup screen and the news all the time and wakes it when something matters; in each wake-up (an *episode*) it looks things up one step at a time and decides. There are no timed cycles. Its level is `agent.level` in Admin:

- **on** (the default): it trades the Alpaca paper account, **stocks and options**, through the bot's own risk checks and execution, inside its envelope.
- **off**: nothing decides. Stops and targets rest at the broker, and the options monitor, maintenance and the overnight rules run either way.

**What wakes it** (observations, scored in code and queued per subject: a burst waits 2–10 s to become one wake-up, risk before opportunity before review, and a subject that woke it waits `agent.wake_cooldown_minutes` unless its salience rises 15 points, a P0, its own watch or the owner):

| Source | Priority |
| --- | --- |
| News, around the clock: every trigger candidate that passes the wire's gates on the item itself (fresh, not old news, confirmed for entries). Outside the session it can only set watches and notes | P0 bad news on a holding (or a critical market review while it holds anything), P1 entry ideas, P2 the rest |
| The setup screen (`src/agent/screen.ts`), on each closed minute of the price board (the scan universe and what the engine tracks): the first close above the opening range (the first 15 minutes) and, an hour in, a new session high, each on at least twice the stock's median minute volume today (IEX volume against its own). While buys are allowed and the envelope would take one, a minute's best five setups on stocks it doesn't hold wake it together, with a SUBJECT section each | P1 |
| The session: premarket (plan; watches and notes only), the open after its buffer, the closing window while it holds anything, after the close | P2, P2, P1, P3 |
| A held stock moving `schedule.trigger_move_pct` since its last review (checked every 5 s in session against live prices; the observers read the book's plans and options from the database at most every 15 s), again at every further step | P0 down, P2 up |
| A stop-loss or take-profit leg the broker fills | P2 |
| A macro release 15 minutes out | P2 |
| Its own watches (price above or below, a % move, news at a severity, a time) | the watch's |
| A quiet-time review in session once nothing has woken it for `agent.sweep_minutes` (2 h) | P2 |
| The owner's question (Agent page) | P2, read-only |
| The owner's *Wake the agent* (`agent.review`, optionally about up to 5 tickers) | P1 |

**An episode**: a short brief (why it woke, its book, the session and the limits in force, the benchmarks, a SUBJECT section per stock it woke for with its latest 3 news items from the last 24 h (or a line saying there are none), its notes and watches), then steps. Each step is one JSON object under a grammar: a call to one of its tools, or the answer: the decision schema (buy, sell, adjust_exits, hold, buy_option, close_option, hold_option) plus watches, notes and a reply. The tools are read-only: `book`, `option_menu`, `quote`, `technicals` from Alpaca's daily and 5-minute bars, `news`, `dossier`, `item`, `past_decisions`, `calendar`, from the history store `history` and `past_news`, and for P2 and P3 episodes `research`: web research on one question, on the search service's free engines only, 1–3 minutes, returning a memo with its sources. Limits per priority as in crypto (`agent.limits`). It may name any ticker it has a price for (the broker's stream or the price layers, which track the scan universe) or holds.

**Its decisions** are normalized (`normalizeDecision`), sales first: one per stock and per options position, any number about what it holds (it manages the whole book) and at most 3 new entries. A buy happens only in the regular session after the opening buffer (the closing window counts as the close phase: overnight or multi-day buys with conviction 8 or more) and passes the **envelope** (as in crypto). Then each decision goes through `executeDecisions` (the buy rules, the options rules, bracket and OCO orders at the broker), one at a time so the envelope sees each entry before the next. A buy's `allocation_pct` and an option's `premium_pct` are cut to the envelope's share of the caps and the hour's budget first. An options entry must use contracts from an `option_menu` it loaded in the same episode (at most three per episode), and nothing else passes. Each decision is a `decisions` record with `trigger_kind: "agent"` and `agent_episode_id` set, and positions it didn't mention get no default hold. Buys post to Discord when they fill; its sales post too, linking the episode. The account it reads is the engine's 15-second snapshot. While an episode runs, maintenance only syncs orders, so it never re-protects a stock the agent is selling. Exits are never rate-limited, and stops only move up.

Positions the old core book opened (plans with `book: "core"` and a plain GTC stop) are ordinary positions now: the agent manages them, and maintenance protects them like any other.

**Circuit breakers** as in crypto: a trip pauses its new entries until the owner resumes them (Agent page, `agent.resume_entries`); exits, stops and the overnight rules go on, and a slow model only pauses its entries until it is fast again. **Where to see it**: the Agent page (the model's live feed: every call's thinking and answer as it streams, once a second, and which of the server's slots are busy; the episodes, watches and notes, *Ask the agent* and *Wake the agent*), the Live page (the same feed), the decisions and trades tables (an agent decision links its episode), and the heartbeat's `agent` block.

## News engine (the wire)

The engine reads about 80 free news, filing and market-data sources itself, so the AI doesn't have to find everything by searching, and so the agent hears about news as it happens.

```
sources (each isolated) → normalize → dedupe → tag tickers → classify → relevance filter
  → cluster (confirmations) → severity → notable flag → wire_items → policy → trigger gates
  → wire_triggers → the agent (an observation: it wakes, looks things up, decides; the risk checks as always)
wire_items → dossier → the agent's brief and its news and dossier tools
```

| Part | Code | What it does |
| --- | --- | --- |
| Catalog | `wire/catalog.ts`, `wire/sources/` | Every source: a generic kind (RSS, JSON, HTML, headless, Statuspage, Telegram channel preview, list diff) with a URL and interval, or a custom adapter (EDGAR, halts, FDA, calendars, insiders, odds, the price layers). Keyed sources stay off until their key is set. Tiers: 1 = primary or official (filings, halts, agencies), 2 = major outlets, 3 = aggregators and social |
| Poller, fetch, limiter | `wire/poller.ts`, `fetch.ts`, `limiter.ts` | One loop per source; its errors only change its own health. Conditional GETs, one attempt per call, exponential backoff up to 30 min. Repeated 403/429 answers mark a source `degraded` and slow it right down. Per-domain token buckets; both bots share the server's IP, so shared limits (SEC's 10 requests/s, GDELT, StockTwits) are split between them |
| Pipeline | `wire/wire.ts`, `normalize.ts`, `cluster.ts`, `severity.ts`, `notable.ts` | Strips HTML and tracking parameters, dedupes, tags tickers, classifies, drops what's irrelevant, groups near-duplicates (title Jaccard ≥ 0.6 within 6 h; later copies from other domains are confirmations), scores severity 0–100, and flags what reaches the Live page |
| Lexicon | `wire/lexicon.ts` | Stock language rules: tickers match as a cashtag (`$NVDA`), an exchange tag (`(NASDAQ: NVDA)`) or the ticker in capitals, except tickers that are everyday words (A, IT, ALL, NOW…), which need one of the first two. Sponsors, applicants and contract recipients are mapped to tickers through the SEC company list (`sources/companies.ts`) |
| Market-data detectors | `wire/anomaly.ts`, `wire/metrics.ts` | Price, volume and market-wide shocks from closed 1-minute bars (z-scores, judged on the residual against SPY) across the scan universe. `MetricWatcher` turns numeric feeds (VIX, yields, odds, attention, short volume) into items: level, change and spike rules, the first reading only a baseline, one item per excursion |
| Dossier | `wire/dossier.ts` | What our feeds know about an episode's subjects: cluster roots ranked by severity × recency, capped per symbol, plus market-wide items, the next 72 h of scheduled releases and earnings (`calendar.ts`), and two gap lists (moves no item explains, high-severity items not yet confirmed) |
| Policy and gates | `wire/policy.ts`, `wire/trigger.ts` | The bot's rules turn an item into candidate triggers (review a holding, evaluate an entry, review the market, fill the gap behind an unexplained move); the shared gates decide and record why |
| Scraper sidecar | `apps/scraper` | Headless Chromium for the few pages that need JavaScript, shared by both engines. Its own container with no host port; the engine reaches it at `SCRAPER_URL` |

Files headed `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.` are identical in both repos apart from the `@cmb`/`@smb` import prefix. The catalog, lexicon, policy and `sources/` are per bot.

**Severity** keeps every part for the audit trail: the category base (or an adapter's own, e.g. a shock scaled by its z-score) × a tier factor, +20 if it names a holding (+8 for a candidate, watchlist or universe symbol, +5 market-wide), +8 per extra independent domain up to +16, and points for a matching price or volume anomaly within ±15 min. The thresholds (`wire.thresholds`, defaults 30 / 55 / 70 / 85) mean: annotate the dossier, review a holding, evaluate an entry, critical.

**What wakes the agent** (`wire/policy.ts`): bad news about a holding at review severity (a review, or `emergency_action` when critical and confirmed); good news naming at most three unheld tickers at evaluate severity in an entry category (M&A, FDA, earnings, guidance, index changes, analyst actions, general news); an official policy statement or a market shock while something is held (a market review); a sharp move or a halt resumption in a holding (a review); an unexplained jump in an unheld stock, only when `unexplained_move_entries` is on (off by default: on 2026-10-27, 9 of these checks cost $2.17 and all ended in hold). Odds swings only count when critical and something is held. Insider buying, attention spikes and our own readings (VIX, yields, auctions, EIA, COT, short volume) only annotate the dossier.

**Trigger gates**: the agent hears about every candidate that passes the gates on the item itself: `wire.mode` → fresh (first seen within `trigger_max_age_minutes`, never a source's first poll after a restart, published under 2 h ago) → confirmation for entries (a tier-1 source, two independent outlets, or a matching price move). The rest of the gates decide only the trigger's record, its alerts and the emergency exit: shadow mode (logged, no alert or emergency action) → engine running and kill switch off → **regular session** (outside it, bad news about a holding still alerts at once) → per-symbol cooldown → hourly and daily caps. A trigger never trades by itself; the one exception is `emergency_action` for a holding hit by a critical, confirmed, negative event, and it only ever reduces risk.

**Settings** (the `wire` section, changed live from Admin; defaults): `mode` live, `thresholds` 30/55/70/85, `entry_confirmation` on, `unexplained_move_entries` off, `trigger_max_age_minutes` 15, `symbol_cooldown_minutes` 30, `max_event_cycles_per_hour` / `_per_day` 4 / 24 (the trigger caps), `emergency_action` review, `anomaly` price z 4 / volume ×5 / market z 4, `retention_days` 30, `odds_swing_pts` 15, `scan_max_symbols` 1,500, `scan_min_dollar_volume` $20M.

**Events and commands**: `wire.item`, `wire.notable`, `wire.dossier`, `wire.trigger` and `wire.source` on the live stream; `wire.replay` (Admin) re-runs an item through the policy as a dry run. Source health is in the heartbeat (`wire.sources` in `engine_status`'s `detail` document, rewritten once a minute: state, last error, items and drops in 24 h, lag, and a detail line for the price layers).

**Failure behavior**: the wire never throws into the engine. A broken source, a bad payload or a database hiccup costs at most that batch of items, and trading goes on as it would without the wire. On boot the cluster index and seen ids are rebuilt from MongoDB, and nothing from a source's first poll can trigger, so a restart never replays old news as new. A dead scraper sidecar only takes the headless sources down. Settings change live from Admin (`wire.mode: off` turns the whole engine off; `disabled_sources` turns single sources off, price layers included).

### Price layers (news engine only)

The free Alpaca plan streams 30 symbols on one IEX connection, too few to notice an unexplained move across the market. The news engine merges free feeds into one view of about 1,500 liquid symbols (`market/price-board.ts`). **Order prices, stops and every risk check keep using Alpaca's own data.**

| Layer | Feed | Carries |
| --- | --- | --- |
| A | Alpaca IEX trades (the 30-symbol stream) | held, underlyings, SPY/QQQ, focus, watchlist |
| B | Alpaca IEX minute bars for every symbol (`bars: ["*"]`, same connection) | closed 1-minute bars with IEX volume |
| C | Yahoo Finance streamer | the tracked set |
| D | Finnhub trades WebSocket | focus, then watchlist, then held (≤ 50) |
| E | Alpaca snapshots, polled only while B and C are down | the latest 1-minute bar |

Each closed minute becomes one bar per tracked symbol, the close from the best layer that saw it (A > D > C > B > E), the volume from IEX only (B, else E) so the volume baseline never mixes feeds. The tracked set is the **scan universe** (`market/scan-universe.ts`, rebuilt daily before premarket from 20 sessions of consolidated daily bars: price ≥ `risk.min_price`, average dollar volume ≥ `wire.scan_min_dollar_volume` ($20M), top `wire.scan_max_symbols` (1,500)) plus held stocks, underlyings, benchmarks, the agent's watches, today's movers and the focus. Each layer reports as a wire source, so its health shows beside the news sources.

## Live stream

The engine runs an authenticated WebSocket server (`/v1/stream`) plus `/healthz` and `/readyz`, published on `127.0.0.1:8788`; the reverse proxy terminates TLS for `engine.stockmarketbot.app`.

1. The browser asks the dashboard for a 60-second HMAC token (`/api/stream-token`), `owner` scope with a valid owner session, `public` otherwise. The secret is shared by Vercel and the engine.
2. The browser connects and sends the token in the first frame (never in the URL), with the last `seq` it saw.
3. The engine replays everything after that `seq` (from memory, falling back to MongoDB), then streams live. 15-second pings; the client reconnects with backoff and a fresh token.

Safety: an Origin allowlist, per-IP and total connection limits, 4 KB client frames, slow clients dropped, 12-hour sessions, owner-only events (commands, errors) never sent to the public. Web content (titles, excerpts) is sanitized before it's emitted, and everything from the web or the news is fenced as untrusted data in the agent's prompts.

Events are typed (`packages/core/src/events.ts`) and carry a strictly increasing `seq`. High-frequency events (tickers, heartbeats, the model feed: `llm.call`, `llm.delta` once a second, `llm.done`, `llm.status`) are streamed with `seq: 0` and not stored; everything else expires after `EVENT_RETENTION_DAYS`. Agent events carry their episode id, so each episode page shows its whole trail.

**What "thinking" means here:** the model's own thinking and answer for every call, as they stream (owner-only unless `agent.public_thinking`: it quotes untrusted news text), each tool call and its result, each decision's rationale and evidence, and every risk check.

## Options

**Menus, not open chains.** For a stock the agent asks about (its `option_menu` tool, at most three per episode), code loads listed contracts (for open interest) and the chain snapshot (quotes, greeks, implied volatility) from Alpaca's free indicative feed, then keeps a short menu: inside the DTE window, strikes within ±25%, a two-sided quote no wider than `max_spread_pct`, enough open interest, deltas from 0.12 to 0.85 (so spreads' short legs are available), at most two expirations near the middle of the window, strikes spread evenly. The agent can only pick contracts from a menu it loaded.

**Entries** (`evaluateOptionEntry`): engine running, options enabled, loss limits, phase (the regular session; the closing window only at conviction ≥ 8), conviction, open positions, daily trades, contract offered, correct underlying and type, spread shape (same expiration, short strike further out), DTE, delta of the bought leg, liquidity of every leg, a positive net debit below the spread's width, spread reward:risk, and premium (per trade, total, cash and options buying power). The limit price is between the midpoint and the ask (`entry_aggression`); a day order is canceled if it doesn't fill within `fill_timeout_seconds`. Spreads are one `mleg` order (positive limit = debit), so both legs fill together.

**Exits** (`exitTrigger`, checked every `monitor_seconds`): a time stop once `close_at_dte` days or fewer remain (after 10:00 ET), the underlying crossing the agent's invalidation level, the position's value falling `stop_loss_pct`, the underlying reaching the agent's target, the value rising `take_profit_pct` (capped at 95% of a spread's width). Urgent exits go at market; targets and the agent's closes try a limit between the midpoint and the bid first. Nothing is held into expiration, so nothing is exercised or assigned.

**Reconciliation**: a position the broker no longer holds is closed in the books with an alert; an option position the books don't know is reported, not touched.

## Data model (MongoDB, database `stockmarketbot`)

| Collection | Contents |
| --- | --- |
| `settings`, `engine_state` | the versioned settings document; desired state (running/paused/halted, kill switch, when the agent was last turned on or resumed, and any breaker pause on its entries) |
| `engine_status`, `engine_lease` | heartbeat (health of everything, the agent, live prices, AI calls today: `engine`, every 10 s, its error, AI-call and trigger counts read once a minute; the news sources' health: `detail`, every minute; the dashboard reads the two as one); single-instance lease |
| `events` | persisted stream events (replay, episode trails) |
| `commands`, `audit_log` | owner commands and results; every control and settings change |
| `decisions` | each requested action (stock or option), every risk check, what happened, the order ids, and the agent episode that made it |
| `orders` | every Alpaca order and leg (stocks, option legs, spread parents), synced continuously |
| `position_plans` | live stop/target/horizon/thesis per stock; plans from the old core book carry `book: "core"`, `theme` and `notes` |
| `option_positions` | each options position: legs, entry, exits, live mark, exit and realized P&L |
| `daily_stats` | per-day equity, P&L vs SPY, wins/losses |
| `cache` | what the website shows from Alpaca: the account snapshot, equity history, chart bars; also the day's scan universe |
| `wire_items` | every stored news item: normalized text, tickers, category, tier, severity and its parts, cluster, confirmations, price when first seen, notable reasons (TTL `wire.retention_days`, 30) |
| `wire_triggers` | every trigger candidate the policy produced, with the gate that passed or stopped it and why (TTL `wire.retention_days`) |
| `agent_episodes` | each agent episode: what woke it, the brief, every step (tool, arguments, result, thinking, tokens), the answer and what became of it; long text capped (the history store keeps it all); 14-day TTL |
| `agent_watches`, `agent_notes` | the agent's watches and its notes per subject (TTL) |
| `ai_calls`, `notifications`, `login_attempts` | every AI call (research calls also count their searches; costs are 0 since the local model), alerts, sign-in rate limits |
| `search_usage` | what research's metered search providers cost this bot each UTC month (one document a month), for their pacing ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)); the agent's research uses only the free engines |
| `auth_*` | owner sign-in (Better Auth magic links, or emailed codes in the Home Screen app; only `OWNER_EMAIL`), written by the dashboard |

The timed cycles' collections (`cycles`, `reports`, `core_reviews`, `seed_runs`) and the old shadow book (`shadow_positions`, `shadow_fills`) are no longer written or shown; their documents stay in MongoDB.

## Testing

Engine (in-memory MongoDB, a fake Alpaca broker that fills stocks, single legs and spreads): the session, risk state, every stock and options rule, execution (brackets, OCOs, partial sells, stop ratchets), options entries/exits/monitoring/reconciliation, order sync and FIFO P&L (including short option legs), option menus, the agent (its tools, observations, setup screen, envelope, breakers and decisions), the live model feed, maintenance and the day's record, trade updates, both Alpaca WebSocket clients against a local server, the stream server over real sockets, and the engine itself driven by commands. The news engine: every source parser against trimmed real payloads, the pipeline, clustering, severity, the dossier, trigger gates and the stock policy, the anomaly and metric detectors, the price board and its layers (including Yahoo's protobuf frames), the scan universe, and the headless client. Core: settings, commands, tokens, events, options helpers, report normalization. Dashboard: formatting, site metadata, the owner check.

## Known limitations and risks

- **Not yet run against Alpaca's live paper APIs.** The REST shapes and WebSocket protocols follow Alpaca's documentation and are tested against fakes; the first market day on the server is the real test. Things to watch: options order rejections (price increments, levels), and the paper trade stream's message format.
- **Options exits need the engine.** If the container is down, options positions aren't monitored. Docker restarts it automatically, and the most any position can lose is what was paid.
- **The agent shares the model server** with the crypto bot's agent and the article summaries (three slots). Busy hours slow every call; the Agent page shows its speed, and a slow model trips a recorded breaker.
- **Indicative options data.** The free feed's quotes can lag or differ from OPRA. Paper fills follow Alpaca's own simulation, so paper results can be better than live trading would be.
- **IEX data.** Stock prices are real, but IEX sees only a slice of volume, and quieter names can have stale last trades (the quote midpoint is used when it's tight and newer).
- **Free plan limits.** One market data connection and 30 streamed symbols; anything beyond that is priced from the price layers or REST snapshots.
- **LLM behavior can change** with model updates; the AI never bypasses the risk checks.
- **Free news and price sources can change or vanish.** Several are unofficial (ForexFactory's calendar, the Yahoo streamer, Telegram channel previews, scraped pages), and some rate-limit the shared IP (GDELT answers 429 most of the time and runs degraded). Each failure only degrades that source or layer, and the heartbeat shows it, but coverage can thin out without any code change.
