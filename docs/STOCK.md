# Architecture

How StockMarketBot is built and why: the deployment boundaries, the live stream, the trading cycle, the agent, the news engine and its price layers, the one-time seed buy, options, the data model, and the known limitations. The design follows CryptoMarketBot's (an always-on engine and a read-only dashboard); the trading logic is StockMarketBot's own.

## Scope decisions

| Decision | Why |
| --- | --- |
| **Engine + dashboard split** | The bot used to run inside Vercel functions triggered by an external cron, with a 300-second limit per run. An always-on engine has no time limit, keeps WebSocket connections to Alpaca, watches options exits every few seconds, and streams its work to the dashboard as it happens. |
| **Alpaca paper only** | Trading always goes to `paper-api.alpaca.markets`; there is no live-trading code path. Only the engine holds the keys. |
| **Defined-risk options only** | Long calls, long puts, call/put debit spreads. The most any position can lose is what was paid, so there are no margin calls, a spread's short leg is always covered by its long leg, and engine downtime can't turn into an unbounded loss. |
| **A local model** | Qwen 3.6 35B-A3B on the server's two GPUs (llama.cpp), as `local/qwen3.6-35b-a3b-q2`, through the `ai` SDK: no outside AI service, no key, no cost. It decides, and it researches through our own search service and scraper, without X ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)). Grok, through Vercel AI Gateway, did both until 2026-10-28. |
| **MongoDB Atlas** | One database shared by the engine (the only writer of trading state) and the Vercel dashboard. |
| **Monorepo (pnpm workspaces)** | `packages/core` holds what both apps must agree on: settings, events, commands, document types, the report schema, options helpers, FIFO P&L. |

## Components and boundaries

```
Browser ──https──▶ Vercel (Next.js dashboard) ──▶ MongoDB Atlas ◀── Engine (Docker, your server)
   │                                                                   │  ▲  ▲
   └──────── wss://engine.stockmarketbot.app/v1/stream (reverse proxy) ─┘  │  │
                                       Alpaca paper: REST, trade_updates WS, IEX data WS
                                       Local model server (llm) + search service (search)
                                       ~80 free news and price sources (the wire, below)
                                       Scraper sidecar (Docker, headless Chromium)
```

- **The engine owns trading.** It is the only process that talks to Alpaca or the model server. A MongoDB lease guarantees a single running instance.
- **The dashboard never trades and holds no broker keys.** It reads MongoDB (including the account, equity history and chart bars the engine copies into the `cache` collection) and writes only commands, audit entries and owner sign-in records.
- **Control goes through MongoDB.** Commands are inserted by the dashboard, polled by the engine every second, validated twice, audited, and answered with a result. The engine accepts no inbound control traffic; its only listener is the read-only stream.
- **Stocks don't depend on the engine to be protected.** Every buy is a bracket order and every held position gets an OCO pair, all resting at Alpaca. Options exits do need the engine (Alpaca has no bracket orders for options), which is why options are limited to defined risk.

## The engine's loops

| Every | Job |
| --- | --- |
| 1 s | dashboard commands |
| 5 s | heartbeat to `engine_status` (the Admin page) and the stream |
| 15 s | account snapshot for the dashboard; live-price subscriptions; periodic summary |
| 15 s (setting) | options monitor: marks every position, checks its exits, closes what's hit |
| 30 s | scheduler: the phase that's due (premarket / intraday / close / postmarket), or an early intraday cycle when a held stock moves `trigger_move_pct`; at agent level auto, only the core book's reviews and the one-time seed |
| 60 s (15 min off-hours) | maintenance: order sync, the daily loss limit, stock protection, the overnight fallback (at agent level auto, the overnight rules), options reconciliation |
| 5 / 60 min | equity history and chart bars for the website |
| continuous | the news engine: each source on its own interval or stream (below) |
| 1 s | the agent: its observations, watches and the next episode (below) |
| daily, before premarket | the scan universe for the news engine's price layers |
| daily, from the premarket window | the core book's ranking (below) |

Fills arrive instantly over Alpaca's `trade_updates` stream (binary JSON frames on paper). The REST sync still runs every minute, so a dropped connection never loses a fill. Market data comes from the IEX stream (the free plan allows one connection and 30 symbols, so the engine subscribes to held stocks, option underlyings, SPY/QQQ and then the watchlist).

## One cycle

The timed cycles below run while the agent is at level off or shadow; at level auto they stop and the agent decides (see The agent).

1. **Context** (code): account, positions, open orders, quotes and technicals (VWAP, RSI, EMA trend, ATR, opening range, 20-day levels, the 50- and 200-day averages, the 52-week high) for held, watched, requested and moving symbols, the screener, news, the morning briefing, the previous cycle, recent days and their lessons. Intraday and in the closing cycle it also loads **option chain menus** (below).
2. **Research** (the local model, with web search through our own search service and the scraper, no X): a sourced memo. It never decides. Each query, source and chunk of the memo streams as it happens, and the call's `ai_calls` entry counts its searches (each one is billed).
3. **Decision** (the local model, structured output validated with zod): one fixed schema for every phase. It streams too (the headline and decision count appear as they're written). Schema failures are repaired in code when nothing trade-related is lost, else retried with the exact error at a lower temperature; an optional fallback model covers outages, and takes over at once after a timeout.
4. **Risk checks and execution** (code): every decision is checked rule by rule and every check is recorded on the decision and streamed. Exits run first, then holds, then entries by conviction.
5. **Record**: the report (memo, structured output, the exact context, execution summary, cost), the decisions, the cycle's steps.

Every AI call runs on our own model server, so there is no AI budget: nothing caps how many cycles run. When the AI is disabled (no `LLM_URL`), cycles are skipped and the closing rules still run in code.

When a scheduled phase fails (usually its decision), the scheduler retries it (intraday after 4 minutes, up to twice; the other phases right away, up to `schedule.max_phase_attempts` attempts). The failed cycle keeps its research, and the retry reuses it when it's under 20 minutes old and of the same mode instead of paying for it again; the report names the attempt it came from (`research.reused_from`).

## The agent

An agent runs on the same local model ([plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent), `@mb/agent` and `src/agent/`). Code watches the session, prices, the setup screen and the news all the time and wakes it when something matters; in each wake-up (an *episode*) it looks things up one step at a time and decides. Its level is `agent.level` in Admin:

- **shadow** (the default): its decisions fill only in its own simulated account, the **shadow book** (stocks only), and the timed cycles keep trading the Alpaca paper account.
- **auto**: it trades the paper account itself, **stocks and options**, through the cycles' own execution path, and **the timed cycles stop** (premarket, intraday, closing and postmarket cycles, price-move and news event cycles). News triggers are recorded as "handed to the agent", and the owner's *Run now* becomes a review it may act on. Stops and targets rest at the broker as before, the options monitor and maintenance run as before, and the overnight rules always run in the last 7 minutes (the day's end now, not a fallback). The core book's weekly and single-holding reviews and the one-time seed still run in the cycle slot, and the agent waits for them, so they never spend the same cash.

**What wakes it** (observations, scored in code and queued per subject: a burst waits 2–10 s to become one wake-up, risk before opportunity before review, and a subject that woke it waits `agent.wake_cooldown_minutes` unless its salience rises 15 points, a P0, its own watch or the owner):

| Source | Priority |
| --- | --- |
| News, around the clock: every trigger candidate that passes the wire's gates on the item itself (fresh, not old news, confirmed for entries). The session gate and the caps are the timed cycles' | P0 bad news on a holding (or a critical market review while it holds anything), P1 entry ideas, P2 the rest |
| The setup screen (`src/agent/screen.ts`), on each closed minute of the price board (the scan universe and what the engine tracks): the first close above the opening range (the first 15 minutes) and, an hour in, a new session high, each on at least twice the stock's median minute volume today (IEX volume against its own). While buys are allowed and the envelope would take one, a minute's best five setups on stocks it doesn't hold wake it together, with a SUBJECT section each | P1 |
| The session: premarket (plan; watches and notes only), the open after its buffer, the closing window while it holds anything, after the close | P2, P2, P1, P3 |
| A held stock moving `schedule.trigger_move_pct` since its last review (checked every 5 s in session), again at every further step | P0 down, P2 up |
| A stop or target hit: the shadow book's (every 5 s in session, against the bid or last price), or at level auto a stop-loss or take-profit leg the broker fills | P2 |
| A macro release 15 minutes out | P2 |
| Its own watches (price above or below, a % move, news at a severity, a time) | the watch's |
| A quiet-time review in session once nothing has woken it for `agent.sweep_minutes` (2 h) | P2 |
| The owner's question (Agent page) | P2, read-only |
| The owner's *Run now* at level auto | P1 |

**An episode**: a short brief (why it woke, its book, the session and the limits in force, the benchmarks, a SUBJECT section per stock it woke for with its latest 3 news items from the last 24 h (or a line saying there are none), its notes and watches), then steps. Each step is one JSON object under a grammar: a call to one of 12 read-only tools (`book`, `option_menu`, `quote`, `technicals` from Alpaca's daily and 5-minute bars, `news`, `dossier`, `item`, `past_decisions`, `calendar`, and from the history store `history` and `past_news`), or the answer: the cycle's decision schema (buy, sell, adjust_exits, hold, buy_option, close_option, hold_option) plus watches, notes and a reply. Limits per priority as in crypto (`agent.limits`). It may name any ticker it has a price for (the broker's stream or the price layers, which track the scan universe) or holds. The system prompt follows the level; at auto it adds the options rules.

**Its decisions** are normalized with the cycle's rules (`normalizeDecision`), sales first. A buy happens only in the regular session after the opening buffer (the closing window counts as the close phase: overnight or multi-day buys with conviction 8 or more) and passes the **envelope** (as in crypto). Then:

- **In the shadow book** (stocks only; option decisions are recorded as not applicable): the cycle's own `evaluateStockBuy` against the shadow book's account (`computeRiskState` from its equity and cash), cut to the envelope's share. Fills are at the ask or bid (the last price where there is no quote) plus 5 bps, commission-free, whole shares. Sales fill only while the market is open; intraday positions are closed by code 3 minutes before the bell. These decisions are not written to `decisions`.
- **At level auto**: each decision goes through `executeDecisions`, the cycles' own path (the buy rules, the options rules, bracket and OCO orders at the broker), one at a time so the envelope sees each entry before the next. A buy's `allocation_pct` and an option's `premium_pct` are cut to the envelope's share of the caps and the hour's budget first. An options entry must use contracts from an `option_menu` it loaded in the same episode (the cycle's OPTION CHAINS for one stock, at most three per episode), and nothing else passes. Each decision is a `decisions` record with `trigger_kind: "agent"`, `cycle_id` and `report_id` and `agent_episode_id` set to the episode, and no default holds for positions it didn't mention. Buys post to Discord when they fill, as the cycles' do; the agent's sales post too, linking the episode. The account it reads is the engine's 15-second snapshot. The core book's holdings stay the weekly review's. While an episode runs, maintenance only syncs orders, so it never re-protects a stock the agent is selling.

Exits are never rate-limited and stops only move up, at either level.

**Circuit breakers** as in crypto: recorded at level shadow; at level auto each drops it back to shadow and the timed cycles don't come back, and a slow model only pauses its entries. **Where to see it**: Research → Agent, the decisions and trades tables (an agent decision links its episode), and the heartbeat's `agent` block.

## News engine (the wire)

The engine reads about 80 free news, filing and market-data sources itself, so the AI doesn't have to find everything by searching, and so the bot can react to news between scheduled cycles.

```
sources (each isolated) → normalize → dedupe → tag tickers → classify → relevance filter
  → cluster (confirmations) → severity → notable flag → wire_items → policy → trigger gates
  → wire_triggers → event cycle (focused research + decision + risk checks, as always)
wire_items → dossier → every cycle's research and decision prompts
```

| Part | Code | What it does |
| --- | --- | --- |
| Catalog | `wire/catalog.ts`, `wire/sources/` | Every source: a generic kind (RSS, JSON, HTML, headless, Statuspage, Telegram channel preview, list diff) with a URL and interval, or a custom adapter (EDGAR, halts, FDA, calendars, insiders, odds, the price layers). Keyed sources stay off until their key is set. Tiers: 1 = primary or official (filings, halts, agencies), 2 = major outlets, 3 = aggregators and social |
| Poller, fetch, limiter | `wire/poller.ts`, `fetch.ts`, `limiter.ts` | One loop per source; its errors only change its own health. Conditional GETs, one attempt per call, exponential backoff up to 30 min. Repeated 403/429 answers mark a source `degraded` and slow it right down. Per-domain token buckets; both bots share the server's IP, so shared limits (SEC's 10 requests/s, GDELT, StockTwits) are split between them |
| Pipeline | `wire/wire.ts`, `normalize.ts`, `cluster.ts`, `severity.ts`, `notable.ts` | Strips HTML and tracking parameters, dedupes, tags tickers, classifies, drops what's irrelevant, groups near-duplicates (title Jaccard ≥ 0.6 within 6 h; later copies from other domains are confirmations), scores severity 0–100, and flags what reaches the Live page |
| Lexicon | `wire/lexicon.ts` | Stock language rules: tickers match as a cashtag (`$NVDA`), an exchange tag (`(NASDAQ: NVDA)`) or the ticker in capitals, except tickers that are everyday words (A, IT, ALL, NOW…), which need one of the first two. Sponsors, applicants and contract recipients are mapped to tickers through the SEC company list (`sources/companies.ts`) |
| Market-data detectors | `wire/anomaly.ts`, `wire/metrics.ts` | Price, volume and market-wide shocks from closed 1-minute bars (z-scores, judged on the residual against SPY) across the scan universe. `MetricWatcher` turns numeric feeds (VIX, yields, odds, attention, short volume) into items: level, change and spike rules, the first reading only a baseline, one item per excursion |
| Dossier | `wire/dossier.ts` | What our feeds know about a cycle's subjects: cluster roots ranked by severity × recency, capped per symbol, plus market-wide items, the next 72 h of scheduled releases and earnings (`calendar.ts`), and two gap lists (moves no item explains, high-severity items not yet confirmed) |
| Policy and gates | `wire/policy.ts`, `wire/trigger.ts` | The bot's rules turn an item into candidate triggers (review a holding, evaluate an entry, review the market, fill the gap behind an unexplained move); the shared gates decide and record why |
| Scraper sidecar | `apps/scraper` | Headless Chromium for the few pages that need JavaScript, shared by both engines. Its own container with no host port; the engine reaches it at `SCRAPER_URL` |

Files headed `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.` are identical in both repos apart from the `@cmb`/`@smb` import prefix. The catalog, lexicon, policy and `sources/` are per bot.

**Severity** keeps every part for the audit trail: the category base (or an adapter's own, e.g. a shock scaled by its z-score) × a tier factor, +20 if it names a holding (+8 for a candidate, watchlist or universe symbol, +5 market-wide), +8 per extra independent domain up to +16, and points for a matching price or volume anomaly within ±15 min. The thresholds (`wire.thresholds`, defaults 30 / 55 / 70 / 85) mean: annotate the dossier, review a holding, evaluate an entry, critical.

**What can start a cycle** (`wire/policy.ts`): bad news about a holding at review severity (a review, or `emergency_action` when critical and confirmed); good news naming at most three unheld tickers at evaluate severity in an entry category (M&A, FDA, earnings, guidance, index changes, analyst actions, general news); an official policy statement or a market shock while something is held (a market review); a sharp move or a halt resumption in a holding (a review); an unexplained jump in an unheld stock (a gap-fill check), only when `unexplained_move_entries` is on (off by default: on 2026-10-27, 9 of these checks cost $2.17 and all ended in hold). Odds swings only count when critical and something is held. Insider buying, attention spikes and our own readings (VIX, yields, auctions, EIA, COT, short volume) only annotate the dossier.

**Trigger gates**, in order: `wire.mode` → fresh (first seen within `trigger_max_age_minutes`, never a source's first poll after a restart, published under 2 h ago) → confirmation for entries (a tier-1 source, two independent outlets, or a matching price move) → shadow mode → engine running and kill switch off → **regular session** (outside it, bad news about a holding still alerts at once) → per-symbol cooldown → hourly and daily caps. A trigger never trades: it queues a focused event cycle, where the AI and the risk checks decide as usual. Queued events are spaced by `event_min_gap_seconds`, and an event that waits more than 30 min is dropped as expired. Event cycles load a lighter context (no movers, watchlist or Alpaca news; option chains only for the event's symbols).

**Research modes** (`wire.research_mode`):

| Mode | What web research does |
| --- | --- |
| `full` | The usual research; the dossier goes into the decision prompt. Also used whenever the wire is off or unhealthy (fewer than half its sources `ok`), and for the seed |
| `gap_fill` | A shorter prompt that gets the dossier and only fills its gaps: X sentiment, unexplained moves, unconfirmed items, anything critical it missed |
| `auto` (default) | `gap_fill` whenever the dossier has a gap on a stock in the cycle (held, watched, requested or moving) or on the market: an unexplained move, or a high-severity item only one source has. Web research is skipped otherwise, in any phase. Single-source headlines are common (about 180 a day on 2026-10-27, mostly Alpaca and Finnhub company news), so most cycles still run the gap-fill |

Every cycle that reaches research records which one it ran and why (`cycles.research_plan`), and a skip also as `research_skip_reason`.

**Settings** (the `wire` section, changed live from Admin; defaults): `mode` live, `research_mode` auto, `thresholds` 30/55/70/85, `entry_confirmation` on, `unexplained_move_entries` off, `trigger_max_age_minutes` 15, `symbol_cooldown_minutes` 30, `event_min_gap_seconds` 60, `max_event_cycles_per_hour` / `_per_day` 4 / 24, `event_research` x_verify (45 s; event decisions 90 s), `emergency_action` review, `anomaly` price z 4 / volume ×5 / market z 4, `retention_days` 30, `odds_swing_pts` 15, `scan_max_symbols` 1,500, `scan_min_dollar_volume` $20M.

**Events and commands**: `wire.item`, `wire.notable`, `wire.dossier`, `wire.trigger` and `wire.source` on the live stream; `wire.replay` (Admin) re-runs an item through the policy as a dry run. Source health is in the heartbeat (`engine_status.wire.sources`: state, last error, items and drops in 24 h, lag, and a detail line for the price layers).

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

Each closed minute becomes one bar per tracked symbol, the close from the best layer that saw it (A > D > C > B > E), the volume from IEX only (B, else E) so the volume baseline never mixes feeds. The tracked set is the **scan universe** (`market/scan-universe.ts`, rebuilt daily before premarket from 20 sessions of consolidated daily bars: price ≥ `risk.min_price`, average dollar volume ≥ `wire.scan_min_dollar_volume` ($20M), top `wire.scan_max_symbols` (1,500)) plus held stocks, underlyings, benchmarks, the watchlist, today's movers and the focus. Each layer reports as a wire source, so its health shows beside the news sources.

## One-time seed buy

The owner can put a dollar amount into long-term core holdings at a set time (Admin → One-time seed, the `seed.schedule` and `seed.cancel` commands).

```
scheduled ──(due, engine running, regular session)──▶ running ──▶ done | failed
    │ └──(not started before the closing window that day)──▶ failed ("missed")
    └──(seed.cancel)──▶ canceled
```

- **When**: in the regular session, after `schedule.open_buffer_minutes` (10) from the open, so a 09:30 ET schedule runs about 09:40.
- **What it buys**: an ordinary intraday cycle with full research whose prompt asks only for long-term core buys. Code then holds the AI's answer to it: buys only, at most three, none of a held symbol, every one `multi_day`; the total at most the seed amount + 5%; exit levels a core hold can live with (about a 7.5% stop and a far target).
- **Risk**: execution goes through the usual stock execution, so every risk check and cap applies. The per-position cap (`risk.max_position_pct`) clamps each buy, so a seed larger than that cap needs at least two holdings; the AI is told so.
- **Once**: only one run can be scheduled or running, and a new one is refused while any run is `done` unless the command sets `force`. A run is a single attempt: a failure is alerted and never retried. `seed.started` and `seed.completed` go on the live stream.

## Core book (long-term holdings)

A fixed share of equity (`core.target_pct`, 50%) in a handful of long-term holdings, each with a written thesis and invalidation, reviewed weekly instead of every cycle; day and swing trading run with the rest. The yardstick is beating SPY over months. The design and its rollout are in [plans/CORE-BOOK.md](plans/CORE-BOOK.md). It is **off** (`core.enabled: false`) until the owner turns it on in Admin → Core book. Everything below is built; switching it on is the owner's step. A dry run is safe at any time.

**On the dashboard**: the **Core page** (`/core`: the book against its target and against SPY since it started, each holding with its thesis, invalidation, stop and latest review notes, the review history with every decision and the watch list, the day's ranking and the themes) and a page per review (`/core/reviews/[id]`: each decision with every rule checked, the theses, the research memo; a core trade's report link lands there). **Admin** has the *Dry run (plan only)* and *Run core review now* buttons and the Core book settings; Holdings marks core positions; **Analytics** compares the books since the core book started; **Strategies** counts core trades as their own book.

**Settings** (the `core` section; defaults): `enabled` off, `target_pct` 50, `band_pct` 5, `min_holdings` / `max_holdings` 4 / 8, `max_holding_pct` 15 (per stock, % of equity), `max_index_etf_pct` 25 (SPY, QQQ, DIA, IWM, VTI, VOO), `max_theme_pct` 50 (% of the book), `stop_pct` 15, `min_conviction` 7, `max_trades_per_review` 6, `review_weekday` / `review_time_et` mon / 10:15, `universe_size` 100, `themes` (one per line, `AI buildout: NVDA, AVGO, TSM`; tickers optional).

**The ranking** (`core-book/ranking.ts`, `core-book/data.ts`), built once per trading day from the premarket window on (and again that day if the themes, `universe_size` or benchmarks change), cached under `core:ranking` and shown on the dashboard's Core page:

- **Candidates**: the scan universe's top `universe_size` names by dollar volume, the benchmark ETFs, every theme ticker and every held stock. Funds whose names mark them as leveraged, inverse, volatility or option-income products are left out (a holding never is), as is anything Alpaca doesn't list as an active, tradable US equity.
- **Data**: a year of consolidated (SIP) daily bars, completed sessions only (380 calendar days; about four pages of one request for ~150 symbols). Per name: the 50- and 200-day averages, 3/6/12-month returns, the 12-month return without the last month (12-1), returns minus SPY's over the same days, distance from the 52-week high, annualized volatility of the last 60 daily returns, the year's worst drawdown, 20-day dollar volume.
- **Ranking**: a trend filter (price above the 200-day average, the 50-day above the 200-day), then a 0–100 score among the names that pass: the mean percentile of the 12-1 month and 6-month returns, each divided by the volatility, floored at 15% (about the market's, so a dollar or bond fund can't outrank stocks on calm alone). Only completed sessions count: a daily bar is stamped at midnight ET and Alpaca's `end` is inclusive, so the bars end a moment before the build day. The weekly review will see the top 25 (`CORE_TOP_CANDIDATES`), every theme ticker and every holding.

A failed build is retried after 30 minutes and the last ranking keeps serving.

**The weekly review** (`core-book/review.ts`), run in the engine's cycle slot so it never overlaps a trading cycle, as a cycle of kind `core` (the phase planner ignores those):

```
book (code)       account, positions, core plans; the first real review adopts the one-time seed's holdings
ranking (code)    rebuilt now, so it covers today's holdings and themes
research (AI)     each holding's thesis and invalidation, the themes, the top 12 candidates, the backdrop (web search, 300 s)
decision (AI)     coreReviewSchema: keep / buy / trim / sell, target weight, thesis, invalidation, verdict, theme, conviction, stop; a watch list
rules (code)      core-book/rules.ts, then core-book/execute.ts: sells and trims, then buys by conviction, then keeps
record            core_reviews (context, research, output, every rule checked), the cycle's steps and events, an alert
```

- **When** (`core-book/schedule.ts`): `review_weekday` from `review_time_et`, in the regular session after the opening buffer and before the closing window. A slot that can't run (holiday, early close, engine down, a failed or skipped attempt) runs at the same time on the next trading day, until the week's review is done; one attempt a day. The owner's **Run core review now** (Admin, the `core.review` command) counts as the week's review and needs the book on and the market open. A **dry run** (`dry_run: true`) does the research and the decision and records the trades it would make as `planned`, without orders or plan changes; it works while the book is off and outside market hours.
- **Rules** (`core-book/rules.ts`; every rule evaluated is recorded on the decision): every holding gets exactly one decision (left out = kept); at most `max_trades_per_review` trades; a buy needs trading not blocked, no circuit breaker, research that worked, a symbol in neither book (v1 never adds to a holding, and never buys what the trading book holds), `min_conviction`, the book (after the review's sells and trims) more than `band_pct` under its target, fewer than `max_holdings`, a tradable asset over `risk.min_price`, and at least 2% of equity after its size is clamped to the per-holding cap (`max_holding_pct`, or `max_index_etf_pct` for SPY, QQQ, DIA, IWM, VTI, VOO), the book's room to its target, its theme's room under `max_theme_pct` of the book, and the cash above `risk.cash_reserve_pct`. A trim sells down to its target weight.
- **Stops**: core holdings rest on a plain GTC stop at Alpaca, no take-profit, so a winner isn't sold at a target. A buy's stop is `stop_pct` below the price unless the AI gives a tighter daily level at least 3% below it; a keep may raise a stop, never lower it. Maintenance gives a core holding without a resting order its stop back (or sells it when the price is already through it).
- **Execution** (`core-book/execute.ts`): market orders; buys re-read the cash after the sells; every trade is also a `decisions` document (`trigger_kind: "core"`, `report_id` = the review, which the dashboard's report links resolve to the Core page), so the journal, trades and analytics see it.
- **Adoption**: the first real review takes what the one-time seed bought and still holds into the core book (its plan becomes `book: "core"` with the seed's reasoning as the thesis, the OCO gives way to a core stop `stop_pct` below the average entry), once. That review writes each adopted holding a proper thesis and invalidation; later reviews add notes (`notes`, the last 12) and only raise stops.
- **Events**: `core.review.started`, `core.review.completed` (each decision's status, trades executed and rejected, cost), plus the usual research, decision, risk-check, order and decision-result events under the review's cycle id.

**Beside the trading book** (`bot/books.ts`; while `core.enabled` is on: switched off, core holdings are ordinary positions again):

| Area | With the core book on |
| --- | --- |
| Trading cycles | Core holdings leave OPEN STOCK POSITIONS and show as read-only CORE BOOK lines; a stock decision on one is rejected (`core book` check). Options on them are allowed |
| `max_open_positions` | Counts trading positions only; the core book has `max_holdings` |
| Trading buys | Deployable cash is also capped so the trading book (stocks at market plus options at their mark) stays under 100 − `target_pct` − `cash_reserve_pct` % of equity; the cap is in the risk FLAGS |
| Protection | Core holdings rest on a plain GTC stop; maintenance re-places it (never an OCO) |
| Overnight cap | `max_overnight_pct` and the intraday-horizon sells count the trading book only |
| Daily loss limit (`flatten_loss_pct`) | Liquidates the trading book and options; core holdings keep their stops. The owner's *Halt & liquidate* still sells everything |
| Price-move triggers | Core holdings don't start early intraday cycles |
| News | `wire/policy.ts withCoreBook`: a core holding never starts a trading event cycle or the emergency exit. Bad news at evaluate severity or above becomes a `core_negative` trigger: a **single-holding review** (its own queue, the event window; research 120 s; keep, trim or sell that holding only). Lesser news, price shocks and halt resumptions wait for the weekly review; halt alerts still go out |
| P&L | Every core order's client id starts `smb-core-` (its stops and liquidations too), so fills carry their book (`OrderFill.book`). `daily_stats.books`: the core book's value at the close and its day's P&L (Alpaca's intraday P&L on the holdings, plus shares sold today from yesterday's close to the sale; % of yesterday's core value), and the trading book's (the rest of the day's P&L), with realized P&L per book |

## Live stream

The engine runs an authenticated WebSocket server (`/v1/stream`) plus `/healthz` and `/readyz`, published on `127.0.0.1:8788`; the reverse proxy terminates TLS for `engine.stockmarketbot.app`.

1. The browser asks the dashboard for a 60-second HMAC token (`/api/stream-token`), `owner` scope with a valid owner session, `public` otherwise. The secret is shared by Vercel and the engine.
2. The browser connects and sends the token in the first frame (never in the URL), with the last `seq` it saw.
3. The engine replays everything after that `seq` (from memory, falling back to MongoDB), then streams live. 15-second pings; the client reconnects with backoff and a fresh token.

Safety: an Origin allowlist, per-IP and total connection limits, 4 KB client frames, slow clients dropped, 12-hour sessions, owner-only events (commands, errors) never sent to the public. Web content (titles, excerpts) is sanitized before it's emitted, and research is fenced as untrusted data in the decision prompt.

Events are typed (`packages/core/src/events.ts`) and carry a strictly increasing `seq`. High-frequency events (tickers, heartbeats, memo and decision progress, reasoning summaries) are streamed with `seq: 0` and not stored; everything else expires after `EVENT_RETENTION_DAYS`. Because every cycle event carries its `cycle_id`, each report page can show its whole thinking trail.

**What "thinking" means here:** the searches, sources, memo, the structured market read, each decision's rationale and evidence, and every risk check. When the provider returns reasoning summaries in the stream, they're shown too (setting `ai.stream_reasoning`); the bot never relies on them.

## Options

**Menus, not open chains.** For up to `max_underlyings_per_cycle` stocks (requested, watchlist, held, SPY, QQQ), code loads listed contracts (for open interest) and the chain snapshot (quotes, greeks, implied volatility) from Alpaca's free indicative feed, then keeps a short menu: inside the DTE window, strikes within ±25%, a two-sided quote no wider than `max_spread_pct`, enough open interest, deltas from 0.12 to 0.85 (so spreads' short legs are available), at most two expirations near the middle of the window, strikes spread evenly. The AI can only pick contracts from the menu.

**Entries** (`evaluateOptionEntry`): engine running, options enabled, loss limits, phase (intraday; closing cycle only at conviction ≥ 8), conviction, open positions, daily trades, contract offered, correct underlying and type, spread shape (same expiration, short strike further out), DTE, delta of the bought leg, liquidity of every leg, a positive net debit below the spread's width, spread reward:risk, and premium (per trade, total, cash and options buying power). The limit price is between the midpoint and the ask (`entry_aggression`); a day order is canceled if it doesn't fill within `fill_timeout_seconds`. Spreads are one `mleg` order (positive limit = debit), so both legs fill together.

**Exits** (`exitTrigger`, checked every `monitor_seconds`): a time stop once `close_at_dte` days or fewer remain (after 10:00 ET), the underlying crossing the AI's invalidation level, the position's value falling `stop_loss_pct`, the underlying reaching the AI's target, the value rising `take_profit_pct` (capped at 95% of a spread's width). Urgent exits go at market; targets and AI closes try a limit between the midpoint and the bid first. Nothing is held into expiration, so nothing is exercised or assigned.

**Reconciliation**: a position the broker no longer holds is closed in the books with an alert; an option position the books don't know is reported, not touched.

## Data model (MongoDB, database `stockmarketbot`)

| Collection | Contents |
| --- | --- |
| `settings`, `engine_state` | the versioned settings document; desired state (running/paused/halted, kill switch) |
| `engine_status`, `engine_lease` | heartbeat (health of everything, schedule, live prices, AI calls today); single-instance lease |
| `events` | persisted stream events (replay, report trails) |
| `commands`, `audit_log` | owner commands and results; every control and settings change |
| `cycles` | every phase run with its steps, trigger, status, AI cost |
| `reports` | research memo + sources + queries, structured output, the full context the AI saw, execution summary, cost |
| `decisions` | each requested action (stock or option), every risk check, what happened, and the order ids |
| `orders` | every Alpaca order and leg (stocks, option legs, spread parents), synced continuously |
| `position_plans` | live stop/target/horizon/thesis per stock; core holdings add `book: "core"`, `theme`, `last_reviewed_at` and `notes` (a missing `book` means trading) |
| `core_reviews` | each core book review: kind, trigger, dry run, the book before and after, what it was shown (`context`), research, the AI's output, every decision with its rule checks and orders, the summary and watch list, cost |
| `option_positions` | each options position: legs, entry, exits, live mark, exit and realized P&L |
| `daily_stats` | per-day equity, P&L vs SPY, wins/losses |
| `cache` | what the website shows from Alpaca: the account snapshot, equity history, chart bars; also the day's scan universe and the core book's ranking |
| `wire_items` | every stored news item: normalized text, tickers, category, tier, severity and its parts, cluster, confirmations, price when first seen, notable reasons (TTL `wire.retention_days`, 30) |
| `wire_triggers` | every trigger candidate the policy produced, with the gate that passed or stopped it and why (TTL `wire.retention_days`) |
| `seed_runs` | the owner's one-time seed buys: schedule, status, allocations, orders, error |
| `agent_episodes` | each agent episode: what woke it, the brief, every step (tool, arguments, result, thinking, tokens), the answer and what became of it; long text capped (the history store keeps it all); 14-day TTL, kept for good once it changed the shadow book |
| `agent_watches`, `agent_notes` | the agent's watches and its notes per subject (TTL) |
| `shadow_positions`, `shadow_fills` | the agent's shadow book: what it would hold, and every simulated fill |
| `ai_calls`, `notifications`, `login_attempts` | every AI call (research calls also count their searches; costs are 0 since the local model), alerts, sign-in rate limits |
| `search_usage` | what research's metered search providers cost this bot each UTC month (one document a month), for their pacing ([SERVER.md §9](SERVER.md#9-the-local-model-server-llm)) |
| `auth_*` | owner sign-in (Better Auth magic links, or emailed codes in the Home Screen app; only `OWNER_EMAIL`), written by the dashboard |

## Testing

Engine (in-memory MongoDB, a fake Alpaca broker that fills stocks, single legs and spreads): the scheduler, risk state, every stock and options rule, execution (brackets, OCOs, partial sells, stop ratchets), options entries/exits/monitoring/reconciliation, order sync and FIFO P&L (including short option legs), the context builder and option menus, prompts, the AI runner's streaming and repair (mocked SDK), whole cycles and their event trails, maintenance, trade updates, both Alpaca WebSocket clients against a local server, the stream server over real sockets, and the engine itself driven by commands. The news engine: every source parser against trimmed real payloads, the pipeline, clustering, severity, the dossier, trigger gates and the stock policy, the anomaly and metric detectors, the price board and its layers (including Yahoo's protobuf frames), the scan universe, the headless client, and the seed run. Core: settings, commands, tokens, events, options helpers, report normalization. Dashboard: formatting, site metadata, the owner check.

## Known limitations and risks

- **Not yet run against Alpaca's live paper APIs.** The REST shapes and WebSocket protocols follow Alpaca's documentation and are tested against fakes; the first market day on the server is the real test. Things to watch: options order rejections (price increments, levels), and the paper trade stream's message format.
- **Options exits need the engine.** If the container is down, options positions aren't monitored. Docker restarts it automatically, and the most any position can lose is what was paid.
- **The agent shares the model server** with the timed cycles, the crypto bot and the article summaries (three slots). Busy hours slow every call; the Agent page shows its speed, and a slow model trips a recorded breaker.
- **The shadow book has no options**: in shadow the agent trades stocks only; at level auto it trades options on the paper account from the menus it loads.
- **Indicative options data.** The free feed's quotes can lag or differ from OPRA. Paper fills follow Alpaca's own simulation, so paper results can be better than live trading would be.
- **IEX data.** Stock prices are real, but IEX sees only a slice of volume, and quieter names can have stale last trades (the quote midpoint is used when it's tight and newer).
- **Free plan limits.** One market data connection and 30 streamed symbols; anything beyond that is priced from REST snapshots each cycle.
- **LLM behavior can change** with model updates; the AI never bypasses the risk checks.
- **Free news and price sources can change or vanish.** Several are unofficial (ForexFactory's calendar, the Yahoo streamer, Telegram channel previews, scraped pages), and some rate-limit the shared IP (GDELT answers 429 most of the time and runs degraded). Each failure only degrades that source or layer, and the heartbeat shows it, but coverage can thin out without any code change.
