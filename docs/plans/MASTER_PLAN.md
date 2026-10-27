# Master plan: one-time seed buys + real-time news engine ("wire")

> **Mirrored file.** An identical copy lives at the root of `cryptomarketbot` and `stockmarketbot`. When you tick a box or change the plan, update both copies.
>
> Written 2026-10-26, revised the same day with the owner's answers (§8). Status: **in progress**. Phase 1 is built and deployed in both repos (see §9); Phases 0 and 2–8 have not started.
>
> **Deadline:** Phase 1 (seed buys) must be deployed **tonight**. It runs on **Tue 2026-10-27 at 09:45 ET (06:45 PT, 13:45 UTC)**.

---

## 0. How to execute this plan

- **Order:** Phase 1 first, because it has a deadline. Phase 0 can run alongside it. Then Phases 2 → 7 in order. Each phase is sized for about one working session.
- **Finishing a phase:**
  - `pnpm typecheck && pnpm test` pass in every repo the phase touched.
  - One commit per repo.
  - **Deploy right away** (engine container and dashboard, as usual). There is no staged rollout: the owner chose to go live as soon as each piece works (§8).
- **Tags:** tasks are tagged **[C]** `cryptomarketbot`, **[S]** `stockmarketbot` and **[both]**. Paths are relative to the root of the tagged repo. The repos are siblings (`../stockmarketbot` from `cryptomarketbot`). Inside a phase, do **[C] first**: crypto trades 24/7, so it can be tested at any hour.
- **Mirrored files:** files marked **mirrored** must be identical in both repos, apart from the `@cmb/core` ↔ `@smb/core` import alias. Write each one in crypto, copy it to stocks, then diff the two. Header line: `// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.`
- **Settings:**
  - Don't edit existing live settings from code or scripts. They change only from the dashboard Admin page (an audited `settings.update` command).
  - The new `wire` section ships with **live defaults** (`mode: "live"`, `research_mode: "auto"`). `SettingsStore.load` already fills new fields from `DEFAULT_SETTINGS` on boot, so deploying is what turns it on. The owner can switch it off from Admin at any time.
- **Code style:** zod schemas in `packages/core`, plain testable functions, `every()` for periodic jobs, `bus.emit()` summaries, `fenceUntrusted()` and `cleanText()`, vitest with `mongodb-memory-server`.
- **Tracking:** tick boxes (`[x]`) as you go and add a line to the **Progress log** (§9).

---

## 1. Goals

1. **One-time seed buys (tomorrow morning).**
   - Each bot puts about **$2,000** into long-term core holdings.
   - What to buy is decided by **research run that morning**, then a Grok decision, then the risk engine. It is not decided in advance.
   - It happens once, and never again unless the owner explicitly asks.
2. **A news engine ("wire") inside each engine.**
   - It takes in news, filings, government and regulator releases, exchange notices, calendars, sentiment and market data **continuously**: streams where a source has them, fast polling (15–60 s) otherwise.
   - It uses **as many free sources as possible** (§4).
   - Every item is stored with the time we first saw it.
3. **Out-of-the-ordinary events trigger trades.**
   - The rules are in §3.5.
   - An event starts a focused event cycle: dossier → Grok decision → existing risk engine → execution. It can buy, sell, reduce or hold.
   - Target time from item to decision: **≤ 90 s**.
4. **Grok mostly just decides.**
   - Scheduled cycles get the dossier from our own feeds.
   - Grok's web and X search shrinks to filling gaps (X sentiment, moves the feeds can't explain, unconfirmed claims). It is skipped when there's nothing to fill (`research_mode: "auto"`).
   - Code never opens a position because of a headline.
5. **Dashboard:**
   - The existing **Research page** in both apps shows **AI research** (Grok) and **our research** (news engine) as separate sections. It is public (§8).
   - The **Live page** shows news engine data **only when it is valid and applies** (§3.12). Everything else stays on the Research page.

**Non-goals for v1:** paid data feeds, X/Twitter scraping (Grok covers X), LLM classification of items, automatic learning, extended-hours stock trading, and any change to risk limits.

---

## 2. Rules for this work

1. **The news engine fails open.** If the wire or any source dies, both engines keep trading as they do today (scheduled cycles, with Grok research falling back to `full`). Wire work never runs inside, or slows, the protection loops (crypto stops every 3 s, stock maintenance, options exits).
2. **No entries from a headline alone.** Every entry goes through the Grok decision and the risk engine. An entry triggered by an event also needs **confirmation**: a tier-1 source, two independent tier-2 domains, or a tier-2 source plus a matching price or volume move. *Why:* on 2024-01-09 the SEC's X account was hacked and posted a fake spot-BTC ETF approval. BTC jumped and then reversed within minutes.
3. **Exits can move faster than entries.** For a held position hit by a critical, confirmed, negative event, the wire starts an immediate review. The optional code-level emergency action defaults to `review` (Grok decides).
4. **Everything from outside is untrusted data.** It is sanitized, length-capped, wrapped in `<untrusted>` fences in prompts, and shown as plain text on the dashboard.
5. **Results must be reproducible.** Every item stores `first_seen_at`. Decisions and analytics use that field, never `published_at`.
6. **Cost is bounded.** Event cycles are capped (4 per hour, 24 per day) and draw on a 30% reserved slice of the daily AI budget (owner-approved, §8).
7. **No triggers after a restart.** Only items first seen within `trigger_max_age_minutes` (15) can trigger. Backfilled items are stored but never fire.
8. **Be polite to free sources.**
   - A per-domain rate limiter.
   - Conditional GET (ETag / If-Modified-Since).
   - A descriptive User-Agent with a contact address (required by the SEC).
   - Respect robots.txt for HTML scraping.
   - Stop polling a source that returns 403 or 429 repeatedly, and mark it degraded.

---

## 3. Design

### 3.1 Where it plugs in (current code)

| Concern | cryptomarketbot | stockmarketbot |
| --- | --- | --- |
| Cycle trigger loop | `apps/engine/src/engine.ts` → `schedule()` (every 30 s) and `runCycle()` (one at a time) | `apps/engine/src/engine.ts` → `schedule()` and `startCycle()`; `bot/scheduler.ts` → `planPhase()` |
| Cycle body | `orchestrator/crypto-cycle.ts` → `runCryptoCycle()` | `bot/cycle.ts` → `runCycle()`; `bot/execute.ts` → `executeDecisions()` |
| Prompts | `ai/prompts.ts` (`cryptoResearchPrompt`, `cryptoDecisionPrompt`) | `ai/prompts.ts` (`researchPrompt`, `decisionPrompt`) |
| AI calls and budget | `ai/runner.ts`, `ai/budget.ts` | same files |
| Risk | `risk/engine.ts` (`evaluateCryptoEntry`, `evaluateExit`), `risk/sizing.ts` | `bot/risk.ts`, checks inside `bot/execute.ts` |
| Live market data | `market/hub.ts`, `venues/kraken/ws.ts` (ticker and book channels only) | `alpaca/market-stream.ts` (IEX trades and quotes, at most 30 symbols), `market/prices.ts` |
| News today | none (Grok only) | `market/context.ts` pulls Alpaca REST `/v1beta1/news` once per cycle |
| HTTP helper | `util/http.ts` (retries, Retry-After) | none; the Alpaca client has its own fetch |
| Owner commands | `packages/core/src/commands.ts`, `engine.ts` → `handleCommand()` | same |
| Settings and migration | `packages/core/src/settings.ts`; `state/stores.ts` fills new fields from defaults | same |
| Research UI | `apps/web/app/research/page.tsx`, `research/[id]/page.tsx` | same paths |

### 3.2 Architecture

```
  streams: Kraken WS (ohlc/ticker), Coinbase WS, Kraken Futures, Alpaca news WS, Alpaca IEX, Finnhub WS, Bluesky Jetstream
  polled:  RSS/Atom (outlets, regulators, PR wires, per-symbol feeds), JSON APIs, EDGAR, status pages,
           venue diffs, calendars, prediction markets, Telegram channel pages, HTML pages, headless (wave 3)
                  │ market data                                   │ items
                  ▼                                               ▼
          anomaly detector ─────────────────────────► normalize → dedupe/cluster → tag symbols
                                                       → classify → score severity → relevance filter
                                                                   │
                                  wire_items (MongoDB) + wire.item event (live dashboard)
                                                                   │
                                                             trigger policy ──► wire_triggers (audit)
                                         ┌─────────────────────────┼──────────────────────────┐
                                    annotate only            event cycle request         emergency action
                                  (next dossier)        Engine.requestEventCycle()     (setting; default
                                                        → queue → focused cycle         "review" = Grok)
                                                                   │
                       dossier (+ optional short Grok check) → Grok decision → risk engine → execution
```

Everything runs **inside each engine process**, under the existing single-instance lease. The one exception is the optional **headless `scraper` sidecar container** in Phase 7.

### 3.3 Module layout (`apps/engine/src/wire/` in each repo)

| File | Mirrored | Role |
| --- | --- | --- |
| `types.ts` | yes | `SourceSpec`, `WireSource` interface (`id`, `tier`, `start(emit, signal)`, `stop()`, `health()`), `RawItem` |
| `kinds/rss.ts` | yes | RSS/Atom poller: conditional GET, per-feed interval and backoff, optional per-symbol URL templates |
| `kinds/json.ts` | yes | JSON poller + mapper function |
| `kinds/html.ts` | yes | HTML fetch + `cheerio` selectors → items |
| `kinds/statuspage.ts` | yes | Atlassian Statuspage v2 (unresolved incidents, upcoming maintenance) |
| `kinds/telegram.ts` | yes | Public channel web preview `t.me/s/<channel>` → messages (no login) |
| `kinds/diff.ts` | yes | Polls a list and emits added, removed or changed entries (venue pairs, products) |
| `kinds/headless.ts` | yes | Client for the Phase 7 `scraper` sidecar |
| `limiter.ts` | yes | Per-domain token bucket (reuse the token bucket in `util/async.ts`) |
| `normalize.ts` | yes | Sanitizing (`cleanText`/`cleanLine`/`cleanUrl`), canonical URLs (strip `utm_*` and fragments), dedupe id = sha256(source + canonical URL or source id) |
| `cluster.ts` | yes | Near-duplicates: title token-set Jaccard ≥ 0.6 within 6 h and overlapping symbols. Later copies become `confirmations` (distinct domains; identical syndicated titles count once) |
| `severity.ts` | yes | Severity formula (§3.4) with a per-part breakdown |
| `anomaly.ts` | yes | 1-min bar ring buffers, EWMA volatility, z-scores, volume multiple, residual against a reference series (§3.6) |
| `calendar.ts` + `macro-calendar.json` | yes | FOMC, CPI, jobs, PCE, GDP and PPI times (UTC) for 2026–2027, with an alert 30 days before the data runs out |
| `dossier.ts` | yes (core) | Selects, ranks, caps and renders items for prompts (§3.8) |
| `notable.ts` | yes | Decides whether an item is shown on the Live page (§3.12) |
| `wire.ts` | yes | `Wire` class: source lifecycle, pipeline, relevance filter, persistence, events, health, `onTrigger` |
| `catalog.ts` | **no** | This bot's source list: one `SourceSpec` per source (§4) |
| `lexicon.ts` | **no** | Category rules and symbol aliases |
| `policy.ts` | **no** | Trigger rules (§3.5) |
| `sources/*.ts` | mostly no | Custom adapters (WebSocket feeds, EDGAR, Kraken/Coinbase specifics) |

**Most sources should be a catalog entry**, not new code: `{ id, kind, url | urlFor(symbol), interval_s, tier, category_hint?, symbols?: "universe" | "held+watch", key_env?, default_enabled }`. That keeps "as many sources as possible" cheap to add.

Per-symbol templated feeds (Google News, Yahoo, Seeking Alpha, Nasdaq) poll round-robin through held, watchlist and universe symbols, within the per-domain limit.

Shared doc types go in `packages/core/src/wire.ts`, since the web app reads them. New dependencies are `fast-xml-parser` and `cheerio`; pin exact versions.

### 3.4 Item model, relevance and severity

```ts
// packages/core/src/wire.ts (both repos; category lists differ per bot)
export type WireTier = 1 | 2 | 3            // 1 primary/official, 2 major outlet/wire, 3 aggregator/social/unknown
export type WireKind = "news" | "filing" | "venue" | "macro" | "derivatives" | "anomaly" | "calendar" | "sentiment"

export type WireItemDoc = {
  _id: string                               // dedupe id
  cluster_id: string                        // _id of the first item in its cluster
  source: string                            // catalog id: "alpaca_news", "edgar", "rss:coindesk", "anomaly"…
  tier: WireTier
  kind: WireKind
  category: WireCategory
  title: string                             // sanitized, ≤ 300 chars
  summary: string | null                    // sanitized, ≤ 1,000 chars
  url: string | null
  domain: string | null
  symbols: string[]                         // bot symbols (BTC/USD, NVDA); [] = market-wide
  published_at: Date                        // what the source claims
  first_seen_at: Date                       // when we ingested it: use this for anything time-sensitive
  polarity: -1 | 0 | 1                      // routing hint only; Grok judges direction
  severity: number                          // 0–100
  severity_parts: Record<string, number>
  confirmations: { domain: string; url: string | null; at: Date }[]
  price_at_seen: Record<string, number>     // symbol → mid at first_seen_at, when a live quote existed
  meta: Record<string, string | number | boolean | null>   // 8-K items, z-scores, odds, funding…
  notable: boolean                          // shown on the Live page (§3.12); can flip to true later, never back
  notable_reasons: ("triggered" | "held" | "focus" | "market" | "cited")[]
  expires_at: Date                          // TTL (retention_days)
}

export type WireTriggerDoc = {
  _id: string
  at: Date
  rule: string                              // policy rule id
  action: "review" | "evaluate" | "gap_fill" | "market_review" | "emergency" | "alert_only"
  status: "fired" | "queued" | "suppressed" | "shadow"
  reason: string                            // why it fired or was suppressed (cooldown, cap, budget, unconfirmed, market closed, mode)
  item_ids: string[]
  symbols: string[]
  severity: number
  cycle_id: string | null
  queue_wait_ms: number | null
  expires_at: Date
}
```

**Relevance filter (before storing).** With this many sources, store only what can matter:
- Items tagged with a bot symbol: crypto universe or held; stocks held, watchlist, or any ticker with price ≥ `risk.min_price`.
- Market-wide macro, regulatory or policy items.
- Every anomaly.

Everything else is counted in source health and dropped.

**Severity** = clamp(0–100) of the following, with every part stored in `severity_parts`:

- **base** comes from the category table below, multiplied by the **tier factor**: 1.0 for tier 1, 0.85 for tier 2, 0.6 for tier 3.
- **relevance:** +20 if held; +8 if a candidate, on the watchlist or in the universe; +5 if market-wide.
- **confirmation:** +8 for each additional independent domain, up to +16.
- **anomaly:** +15 if the same symbol had a matching price or volume anomaly within ±15 min (+5 for IEX volume-only).

Starting base values; tune them from `wire_triggers` after go-live.

| Crypto category | Base | Stock category | Base |
| --- | --- | --- | --- |
| `exploit` (hack, drain, exploit) | 85 | `bankruptcy` (8-K 1.03) | 95 |
| `depeg` (USDT/USDC) | 85 | `restatement` (8-K 4.02) | 90 |
| `etf_decision` | 75 | `delisting_notice` (8-K 3.01, Form 25) | 80 |
| `regulatory_action` (SEC, CFTC, DOJ, OFAC, White House) | 70 | `halt` | 75 |
| `listing_major` (Coinbase / Upbit / Bithumb listing) | 70 | `m_and_a`, `fda` | 75 |
| `tvl_drop` (DefiLlama chain or protocol) | 70 | `late_filing` (NT 10-K/10-Q), `short_report` | 70 |
| `venue_status` (Kraken pair status change), `venue_outage` | 60 | `guidance`, `offering`, `policy_shock` (tariffs, export controls, sanctions) | 65 |
| `price_shock` (scaled by z) | 55 | `earnings` (8-K 2.02 or news), `antitrust`, `cyber_incident` (8-K 1.05) | 60 |
| `macro_release` | 50 | `price_shock` (scaled by z) | 55 |
| `unlock_large`, `treasury_buy` | 45 | `exec_departure` (8-K 5.02), `index_change`, `macro_release` | 50 |
| `volume_shock`, `funding_extreme`, `odds_swing` | 40 | `lawsuit`, `odds_swing` | 40 |
| `upgrade` (fork, mainnet, client release) | 35 | `insider_buy` (Form 4 P), `analyst_action` | 35 / 30 |
| `coinbase_premium`, `sentiment_spike` | 30 | `sentiment_spike` | 30 |
| `partnership` | 25 | `general` | 10 |
| `general` | 10 | | |

**Thresholds** (settings): annotate 30, review 55, evaluate 70, critical 85.

### 3.5 What counts as "out of the ordinary" (trigger policy)

Gating order for every candidate trigger, recorded in `wire_triggers` with the reason:
`wire.mode` → engine running and kill switch off → market open (stocks) → item age ≤ `trigger_max_age_minutes` → confirmation (entries only) → per-symbol cooldown → hourly and daily caps → AI budget (with reserve) → fire now, or queue if a cycle is running.

**Crypto (`[C] wire/policy.ts`)**

| Rule | Signal | Reaction |
| --- | --- | --- |
| `held_negative` | Held symbol, polarity ≤ 0, severity ≥ review | Immediate review. At ≥ critical and confirmed, also `emergency_action` (default `review`) |
| `entry_event` | Universe symbol not held, polarity > 0, severity ≥ evaluate, **confirmed** | Event cycle with an `event_driven` candidate |
| `listing_major` | Coinbase new USD product, or an Upbit/Bithumb listing, for a universe asset | `entry_event` (venue data is tier 1). Mostly informational while the universe is top coins that are already listed everywhere |
| `unexplained_move` | Idiosyncratic shock (z ≥ `anomaly.price_z`) with no wire item for that symbol in 2 h | Short Grok check (`gap_fill`), then decide |
| `exploit_signal` | Confirmed exploit news, or a chain/protocol TVL drop ≥ `tvl_drop_pct` in 1 h, touching a universe asset | Held: review. Not held: annotate only (never a long into a hack) |
| `market_shock` | BTC 5-min z ≥ `anomaly.market_z` | Review all held positions (`market_review`) |
| `depeg` | USDT/USD or USDC/USD off by ≥ `depeg_pct` | `market_review` + alert |
| `macro_reaction` | Scheduled release, then BTC 5-min z ≥ 3 within 10 min | `market_review` |
| `regulatory_shock` | Tier-1 regulator or White House item about crypto or a universe asset, severity ≥ review | Named held asset: review. Broad: `market_review` |
| `odds_swing` | Polymarket/Kalshi market on Fed or crypto policy moves ≥ `odds_swing_pts` in 1 h | Annotate; `market_review` at ≥ critical |
| `venue_status` | Kraken changes a held pair's status (rare for top coins) | Normal review + alert. No automatic sale: with real money the owner would sell on another exchange, which the paper wallet can't model |
| `funding_extreme`, `coinbase_premium`, `venue_outage`, `sentiment_spike` | Thresholds in settings and the lexicon | Annotate (dossier); `venue_outage` also alerts |

**Stocks (`[S] wire/policy.ts`)**

| Rule | Signal | In session | Outside the session |
| --- | --- | --- | --- |
| `held_negative` | Held stock or option underlying: earnings miss or guidance cut, offering, 8-K 1.03/3.01/4.02/5.02, NT 10-K/Q, downgrade, short report, antitrust; severity ≥ review | Immediate intraday review | Discord alert now; priority focus for the next phase |
| `entry_event` | Ticker with price ≥ `min_price`: M&A target, FDA approval, beat-and-raise, S&P inclusion…; severity ≥ evaluate, **confirmed** | Event intraday cycle with the ticker as `requested` | Added to the next phase's focus |
| `halt` | Held symbol halted | Alert; review on resume | Alert |
| `held_shock` | Held symbol 5-min z ≥ `anomaly.price_z` relative to SPY | Review | — |
| `unexplained_move` | New top mover with no wire item in 2 h | Short Grok check, then decide | — |
| `market_shock` | SPY or QQQ 5-min z ≥ `anomaly.market_z` | Review all held positions | — |
| `policy_shock` | White House, USTR, BIS, Treasury or Fed action (tariffs, export controls, sanctions, emergency rates), severity ≥ review | Review all held positions | Premarket focus + alert |
| `macro_reaction` | CPI/jobs at 8:30 ET or FOMC at 14:00 ET, then SPY z ≥ 3 | Review all held positions | Premarket focus |
| `insider_cluster` | Two or more Form 4 purchases at one issuer within 5 days | Annotate (idea for the next cycle) | Annotate |
| `odds_swing`, `sentiment_spike` | Kalshi/Polymarket (Fed, CPI, recession), StockTwits/Telegram spikes | Annotate | Annotate |

Event-cycle exits still go through the existing exit checks, including `min_hold_minutes` for AI-discretionary crypto exits. Only `emergency_action` skips the minimum hold, because it only reduces risk.

### 3.6 Anomaly detection (deterministic)

- Each symbol keeps a ring buffer of 1-min bars (≤ 1,440). σ is the EWMA standard deviation of 1-min log returns over the trailing day, excluding the current bar. z₁ = r₁/σ, z₅ = r₅/(σ√5), z₁₅ likewise. The volume multiple is the bar's volume over the trailing median 1-min volume.
- **Residual move:** r_sym − β·r_ref, with BTC/USD as the reference for crypto alts and SPY for stocks (rolling β). A move the whole market shares is not news about one symbol.
- **Warm-up:** no signals until 120 bars exist. On boot, backfill Kraken OHLC interval 1 (720 bars) and Alpaca 1-min bars for today and the previous session.
- **Re-arm:** after a signal, the symbol can't fire again until |z| < half the threshold **and** 15 min have passed.
- **Stocks:** ignore the first `open_buffer_minutes`. IEX volume is a small slice of real volume, so price z is the main stock signal.
- **Crypto extras:** a spread blowout (> 4× its trailing median) is annotate only. Depeg comes from the stablecoin tickers. The Coinbase premium (Coinbase BTC-USD vs Kraken mid) feeds the dossier.

### 3.7 Event cycles

**Crypto**

- `Engine.requestEventCycle(req)` keeps an event queue (`Map<symbol, EventFocus>`). It merges by symbol and keeps the highest severity. It starts at once when idle, otherwise the moment the current cycle ends (drain in `runCycle().finally`). Event cycles skip `schedule.min_ai_interval_minutes` and use `wire.event_min_gap_seconds` plus the caps.
- `runCryptoCycle(ctx, request: CycleRequest)` replaces the positional arguments: `{ kind: "scheduled" | "price_move" | "manual" | "event" | "seed"; trigger; forcedReviews; requested; events?: EventFocus[]; seed?: { amountUsd } }`.
- In an event cycle, features load for the universe (candles are cached). **Candidates are only the focus symbols:** bullish, not held, in the universe, and entries allowed. Each becomes an `event_driven` candidate whose signal is built from the wire item, with the same hints as `strategies/event-driven.ts`. Held focus symbols become forced reviews, and `market_review` reviews every held position. The daily-trend `judged` filter doesn't apply.
- Research follows `wire.event_research`: `none` uses the dossier only; `x_verify` runs a short Grok check of the trigger and the X reaction, with timeout `event_research_timeout_seconds`.
- The decision prompt gets a `# EVENT` section (rule, items, what moved) and `event_decision_timeout_seconds`.
- New fields: cycle `kind`, `wire_trigger_id`, `wire_item_ids`; decision `trigger_kind`, `wire_item_ids`.

**Stocks**

- Event cycles run only in the regular session, after `open_buffer_minutes` and more than 3 minutes before the close. Outside those hours, items are marked `priority` for the next phase, and held-critical items send a Discord alert at once.
- `runCycle(ctx, { phase: "intraday", trigger: "event: …", requested: focusSymbols, event: EventFocus[] })`. `buildContext(..., { scope: "event" })` is lighter: account, positions, orders, SPY/QQQ, held and focus instruments, the dossier, and option chains for focus symbols only.
- Event cycles skip `schedule.min_cycle_gap_minutes` and use the wire gap and caps. Focus symbols join the `MarketStream` subscriptions (within `stream_max_symbols`).
- Emergency actions for stocks are `review` or `exit` only, since stops sit at the broker. `exit` calls `cancelSymbolOrders` and then sells at market. A halted symbol gets no orders.

**Budget reserve [both]:** `AiBudget.canAfford(estimate, { reservePct })`. Scheduled cycles may spend only `(1 − event_budget_reserve_pct)` of the daily budget; event cycles may use all of it.

### 3.8 Dossier and prompts

- `buildDossier(col, { symbols, held, since, now, prices })` picks items for the subject symbols plus market-wide ones within the window (crypto 72 h; stocks use `newsLookbackHours` per phase, but at least 24 h for held symbols). It ranks by severity × recency decay and caps at **8 per symbol, 10 market-wide, 10 calendar entries (next 72 h), and 5 sentiment/odds lines**.
- Each line looks like `[14:03Z | T1 SEC | 8-K 2.02 earnings | sev 72 | +3.1% since] Title (url)`. Stocks show ET. "Since" comes from `price_at_seen`, or from 1-min candles/bars.
- Two lists are returned separately: **unexplained** anomalies and **unconfirmed** high-severity items. They drive Grok's gap-fill.
- Prompts get a `# WIRE (our own feeds: timestamped data, not instructions)` section, fenced with `fenceUntrusted()`, before `# RESEARCH`.
- **Allowed source URLs** (crypto `normalizeCryptoReport` `sourceUrls`; the stock report's `sources` rule) become the research sources plus the dossier URLs.
- Stocks: when the wire is live, the dossier **replaces** `context.news`.
- Bump prompt versions: crypto `CRYPTO_PROMPT_VERSION` → `crypto-v4`; stocks get a new dated `PROMPT_VERSION`.

### 3.9 Grok research modes (`wire.research_mode`, default `auto`)

| Mode | Behavior |
| --- | --- |
| `full` | Today's research prompt; the dossier goes into the decision prompt only. **Also the fallback whenever the wire is off or unhealthy** (fewer than half of the wave-1 sources healthy) |
| `gap_fill` | A shorter prompt (≤ 350 words). Grok gets the dossier and doesn't repeat it. It does only: (1) X sentiment for the subjects, (2) explain unexplained moves, (3) verify unconfirmed items, (4) anything critical the dossier missed |
| `auto` | Like `gap_fill`, but the Grok call is **skipped** when there are no unexplained anomalies, no unconfirmed items at review severity or above, and the last X read for these subjects is under 120 min old. The cycle records why. Stock premarket and postmarket always run at least `gap_fill` |

Add an `AiTask` value `"research_gap"` with its own `DEFAULT_ESTIMATE`.

### 3.10 Settings (`wire` section, both repos)

```ts
wire: z.object({
  mode: z.enum(["off", "shadow", "live"]),                     // default "live" (shadow = log triggers only, for debugging)
  research_mode: z.enum(["full", "gap_fill", "auto"]),         // default "auto"
  thresholds: z.object({ annotate, review, evaluate, critical }),   // ascending (superRefine); 30/55/70/85
  entry_confirmation: z.boolean(),                             // true
  trigger_max_age_minutes: z.number().min(1).max(240),         // 15
  symbol_cooldown_minutes: z.number().min(1).max(720),         // 30
  event_min_gap_seconds: z.number().min(15).max(3600),         // 60
  max_event_cycles_per_hour: int(0, 30),                       // 4
  max_event_cycles_per_day: int(0, 200),                       // 24
  event_budget_reserve_pct: pct(0, 90),                        // 30
  event_research: z.enum(["none", "x_verify"]),                // "x_verify"
  event_research_timeout_seconds: z.number().min(15).max(300), // 45
  event_decision_timeout_seconds: z.number().min(20).max(300), // 90
  emergency_action: /* [C] */ z.enum(["review", "tighten_stop", "exit"]) /* [S] */ z.enum(["review", "exit"]), // "review"
  anomaly: z.object({ price_z, volume_multiple, market_z }),   // 4 / 5 / 4
  disabled_sources: z.array(z.string()).max(200),              // [] (catalog defaults apply otherwise)
  retention_days: int(7, 730),                                 // 90 (Atlas storage; see Phase 0)
  // [C] only: depeg_pct 1.0, tvl_drop_pct 15, odds_swing_pts 15, funding_extreme_annual_pct 100
  // [S] only: odds_swing_pts 15, scan_max_symbols 1500 (100–5,000), scan_min_dollar_volume 20_000_000
})
```

**API keys.** The owner gets these; each source stays off until its key is set, and secret keys are registered in `secretValues()`.

| Env var | Repo | Purpose |
| --- | --- | --- |
| `SEC_USER_AGENT` | both | Required by SEC fair access. [C] `CryptoMarketBot hello@colinfran.com`, [S] `StockMarketBot hello@colinfran.com`. Both bots share one IP, so together they must stay under 10 req/s |
| `FINNHUB_API_KEY` | both | Market, company and crypto news, earnings and IPO calendars, WebSocket trades |
| `FRED_API_KEY` | both | Macro release values |
| `BLS_API_KEY` | both | Macro release values |
| `COINGECKO_API_KEY` | [C] | Demo plan |
| `ETHERSCAN_API_KEY` | [C] | Gas data |
| `OPENFDA_API_KEY` | [S] | Optional; openFDA works without one at lower limits |
| `COINALYZE_API_KEY` | [C] | Aggregated funding, OI, liquidations, long/short (free, ~40 calls/min) |
| `MASSIVE_API_KEY` | [S] | Massive (formerly Polygon.io) news endpoint (free, 5 calls/min → one poll every 60–90 s) |
| `EIA_API_KEY` | [S] | EIA weekly petroleum and natural gas reports (energy movers) |

CryptoPanic was dropped: it's no longer free (owner, 2026-10-26).

### 3.11 Storage, events and heartbeat

- Collections: `wire_items` and `wire_triggers`.
  - `wire_items` indexes: `{ first_seen_at: -1 }`, `{ symbols: 1, first_seen_at: -1 }`, `{ cluster_id: 1 }`, `{ severity: -1, first_seen_at: -1 }`, `{ source: 1, first_seen_at: -1 }`, TTL on `expires_at`.
  - `wire_triggers` indexes: `{ at: -1 }`, `{ status: 1, at: -1 }`, TTL.
- New collection `seed_runs` (Phase 1).
- Optional new fields: cycle `kind`, `wire_trigger_id`, `wire_item_ids`, `research_skip_reason`; decision `trigger_kind`, `wire_item_ids`; crypto research doc and stock `reports.research` get `mode` and `dossier`.
- `EngineStatusDoc.wire` holds `{ mode, sources: [{ id, state, last_item_at, last_error, items_24h, dropped_24h, lag_s }], items_last_hour, triggers_today, event_queue: string[] }`.
- Events:
  - `wire.item` (severity ≥ annotate; persisted; carries `notable` and `notable_reasons`).
  - `wire.notable` (an earlier item just became notable: triggered or cited).
  - `wire.dossier` (per cycle, with `cycle_id`: the items the AI was given, as compact rows of id, time, source, title, url, severity and symbols, top 15).
  - `wire.trigger`, `wire.source` (state changes), `seed.started` / `seed.completed`.
  - All public (§8), except for the Benzinga caveat in Phase 0.6.

### 3.12 What reaches the Live page ("valid and applies")

The Live page shows only items the **engine** has marked `notable`. The rule lives in one place (`wire/notable.ts`, mirrored, unit-tested), so the web app never has to guess. An item is notable when it is **valid**:
- first seen ≤ 6 h ago;
- not a duplicate (it is the cluster's first item);
- tier 1, or confirmed (§2 rule 2), or an anomaly backed by market data;

**and** at least one of these applies:

| Reason | Applies when |
| --- | --- |
| `triggered` | It fired or queued a trigger (event cycle, review, market review, emergency) |
| `held` | Severity ≥ review and it names a symbol the bot holds now (stocks: also option underlyings) |
| `focus` | Severity ≥ evaluate and it names a symbol in the current cycle's candidates, the stock watchlist, or an owner request |
| `market` | Market-wide (macro surprise, policy shock, depeg, market shock, Fed) with severity ≥ review |
| `cited` | The AI cited its URL as evidence in a decision. Set after normalization, which emits `wire.notable` |

Everything else (tier-3 chatter, low severity, unrelated tickers, suppressed triggers, stale or duplicate items) never appears on the Live page. It stays on the Research page's "Our research" section.

Live page layout (both apps):
1. **Latest cycle trail:** a new **"Our research"** step before the AI research step lists the dossier the AI was given (from `wire.dossier`), collapsed to the top 5 with "show all". When the cycle was started by an event, a **"Triggered by"** banner at the top of the trail shows the trigger item and rule.
2. **New "News that matters" card**, between the cycle and activity cards (full width on mobile). It lists notable items from the last 6 h, newest first, at most 10, plus live additions from `wire.item` / `wire.notable` where `notable` is true. Each row shows time, severity badge, symbols, source and tier, the title linking out, the "move since" figure, and a **why-chip** taken from `notable_reasons` ("Triggered review of SOL", "You hold NVDA", "Cited by the AI", "Market-wide"). Empty state: "Nothing market-moving right now."
3. **Activity feed:** add `wire.trigger` events with status fired or queued only, and `wire.item` / `wire.notable` with `notable: true` only. Everything else is filtered out (the feed's `FILTERS` gets a "News" filter).

### 3.13 Stock price coverage beyond Alpaca's 30 symbols [S]

Alpaca's free stream caps trades and quotes at **30 symbols** (IEX only). That's too few to spot unusual moves across the market (owner, §8). The fix is free feeds in layers, merged by one `PriceBoard`. Crypto doesn't need this: Kraken streams the whole universe.

| Layer | Feed | Symbols | Resolution | Used for |
| --- | --- | --- | --- | --- |
| A | Alpaca IEX trades + quotes (existing `MarketStream`) | 30: held, option underlyings, SPY/QQQ, current focus | tick | Execution checks, protection, held-position triggers. **Unchanged; always wins** |
| B | **Alpaca IEX minute bars, `bars: ["*"]`** on the same connection. Alpaca's docs put no symbol limit on minute bars for the free plan (verify in 0.9) | every symbol that trades on IEX | 1 min | Market-wide anomaly detection (the main breadth layer) |
| C | **Yahoo Finance streamer WebSocket** (unofficial, the feed yfinance uses; protobuf `PricingData`) | the scan universe (up to `scan_max_symbols`, default 1,500) | tick | Faster breadth: seconds, not the minute close. Cross-check for layer B |
| D | **Finnhub WebSocket trades** (free key, ~50 symbols) | current focus + top watchlist | tick | Backup tick feed when Yahoo throttles |
| E | **Alpaca snapshots REST**, batched (many symbols per call, inside the 200 calls/min free limit) | scan universe | 30–60 s poll | Fallback when B and C are both down; daily volume and previous close for the universe |

Rules:
- **The broker stays ground truth.** Order limits, sizing, stops and the risk engine only use Alpaca data, as today. Layers B–E feed anomaly detection, "move since", the dossier and focus selection, never order prices. When an event cycle starts for a symbol outside layer A, it is swapped into layer A first (lowest-priority subscription out), so the decision sees broker quotes.
- **Scan universe** (built daily before premarket): Alpaca `/v2/assets` (active, tradable US equities) → snapshots → keep price ≥ `risk.min_price` and 20-day average dollar volume ≥ `scan_min_dollar_volume` → rank by dollar volume → top `scan_max_symbols`, always including held, watchlist and benchmark symbols. Today's screener movers are added during the session.
- **`PriceBoard`** (`market/price-board.ts`) keeps the latest price per symbol with its source and age. It builds 1-min bars per symbol from the best layer available (A > D > C > B > E) and feeds them to `wire/anomaly.ts`. When two layers disagree by more than 1% on a liquid name for more than a minute, it logs the lower layer as degraded.
- **Unofficial feed hygiene:** the Yahoo client keeps one connection, subscribes in chunks, reconnects with backoff, and backs off for 15 min after repeated errors. Nothing depends on it alone.
**Checked from the trading server (Phase 0.9, 2026-10-26, evening):**
- Alpaca: `/v2/assets` lists 14,410 active US equities (12,684 plain tradable on NYSE, Nasdaq, Arca, NYSE American, Cboe BZX). Snapshots take 1,000 symbols per call (IEX). Latest SIP data is refused on the free plan (403), but **SIP daily bars older than 15 minutes work**: 20 sessions for 1,000 symbols is 3 pages, about 2 s. The universe uses them for dollar volume, since IEX volume is a small slice. `bars: ["*"]` was accepted off-hours; bar flow is confirmed only in session.
- Yahoo streamer: connects from the server; messages are `{"type":"pricing","message":<base64 PricingData>}`; one connection accepted 1,505 symbols. Off-hours only a few symbols tick; the in-session message rate is still to measure.
- Finnhub WS: 50 symbols on the free key (the 51st gets "Subscribing to too many symbols").

- **Upgrades (optional, not free-only):**
  - Schwab Trader API: free with a Schwab brokerage account. Real-time full-market streaming. OAuth refresh tokens last 7 days and rotate on each refresh.
  - Alpaca's paid market data plan: full-market SIP data, unlimited symbols.

  Either would replace layers B and C as the breadth feed (Phase 9).

---

## 4. Sources (free only, as many as useful)

**Rules for picking sources (owner, §8):**
- Free only. API keys are fine.
- **No free tiers with tiny quotas** (for example, dozens of calls a day).
- HTML scraping is fine, and so is headless scraping.

Everything below needs Phase 0 verification of its URL, limits and payload. "Wave" is the phase that builds it.

### 4.1 Crypto [C]

| Wave | id | Source | Transport | Tier | Gives |
| --- | --- | --- | --- | --- | --- |
| 1 | `kraken_ohlc` | Kraken WS v2 `ohlc` interval 1 (existing socket) | stream | 1 | 1-min bars → anomalies |
| 1 | `stables` | USDT/USD and USDC/USD Kraken tickers (data only, never tradable) | stream | 1 | depeg |
| 1 | `kraken_pairs` | Kraken AssetPairs diff (status, new USD pairs) | poll 60 s | 1 | venue status, listings |
| 1 | `status_kraken`, `status_coinbase` | Statuspage JSON | poll 60 s | 1 | outages, maintenance |
| 1 | `rss_core` | CoinDesk, The Block, Decrypt, Cointelegraph, Blockworks, The Defiant | poll 30–60 s | 2 | news |
| 1 | `finnhub_crypto` | Finnhub market news, category `crypto` | poll 60 s | 2 | news |
| 1 | `gov` | SEC press + litigation + trading suspensions, CFTC press, DOJ press JSON API, Treasury press + OFAC recent actions, Fed press, White House presidential actions (RSS/JSON) | poll 120–600 s | 1 | regulatory, policy |
| 1 | `gnews` | Google News RSS search per universe asset (by name, last hour) | round-robin | 3 | broad coverage (Reuters, Bloomberg headlines) |
| 1 | `truth_social` | Trump's Truth Social posts via the trumpstruth.org RSS mirror (verify; fall back to headless on truthsocial.com in wave 3) | poll 30 s | 1 (primary statement) / 3 (mirror lag) | tariff, crypto-reserve and Fed posts that move everything |
| 1 | `macro` | `macro-calendar.json` + ForexFactory weekly calendar JSON (unofficial: times, forecast, actual) | static + poll 300 s | 1/3 | macro times and surprises |
| 2 | `coinbase_products` | Coinbase Exchange `/products` diff | poll 60 s | 1 | listings |
| 2 | `coinbase_ws` | Coinbase Exchange public WS ticker (no auth) | stream | 1 | cross-venue confirmation, Coinbase premium |
| 2 | `kraken_futures` | Kraken Futures public tickers | stream/poll | 1 | funding, open interest |
| 2 | `hyperliquid` | Hyperliquid public `info` API (`metaAndAssetCtxs`) | poll 60 s | 1 | funding, OI for every perp |
| 2 | `deribit` | Deribit public API (DVOL, BTC/ETH funding) | poll 60 s | 1 | implied vol, positioning |
| 2 | `defillama` | DefiLlama free endpoints: chain and protocol TVL, stablecoin supply | poll 300 s | 1 | exploit signal (TVL drop), USDT/USDC mints |
| 2 | `odds` | Polymarket Gamma API, Kalshi public market data | poll 120 s | 2 | Fed and crypto-policy odds swings |
| 2 | `fng` | alternative.me Crypto Fear & Greed | daily | 3 | sentiment |
| 2 | `coingecko` | CoinGecko Demo (key): trending, top movers | poll 15 min (≈ 2,900 calls/month; fits the Demo quota) | 3 | attention |
| 2 | `chain` | mempool.space (fees, mempool), Etherscan gas (key), Solana status page, GitHub releases Atom (bitcoin, geth, agave, rippled, cardano-node…) | poll 5–15 min | 1 | network stress, upgrades |
| 2 | `rss_more` | Bitcoin Magazine, CryptoSlate, DL News, Protos, CryptoBriefing, BeInCrypto, Bitcoinist, NewsBTC, The Daily Hodl, Unchained | poll 60–120 s | 2/3 | breadth |
| 2 | `telegram` | Public channel previews `t.me/s/<channel>`: fast crypto news, exploit alerts, whale alerts (pick channels in Phase 0) | poll 30 s | 3 | speed |
| 2 | `stocktwits` | StockTwits public streams for `$BTC.X`, `$ETH.X`…, plus trending | poll 120 s | 3 | sentiment spikes |
| 2 | `macro_actuals` | BLS API v2 (key) + FRED (key) at release time | event-driven | 1 | exact CPI and jobs numbers |
| 2 | `fedreg` | Federal Register API (no key): "digital asset", "crypto" | poll 600 s | 1 | rules, notices |
| 2 | `coinalyze` | Coinalyze API (key): aggregated funding, OI, liquidations, long/short ratio across exchanges | poll 60 s | 2 | liquidation cascades, crowded positioning |
| 2 | `bluesky` | Bluesky Jetstream WebSocket (no auth): `wantedDids` = a curated list of crypto/finance news and analyst accounts (Phase 0 picks it), plus a keyword/cashtag filter | stream | 3 | fast social news and sentiment |
| 2 | `apewisdom` | ApeWisdom API (keyless): Reddit/4chan mention counts and mention jumps, `all-crypto` | poll 15 min | 3 | retail attention spikes (Reddit workaround) |
| 2 | `gdelt` | GDELT DOC 2.0 API (keyless, throttled): batched OR-queries per universe asset name | poll 5 min | 3 | global breadth and confirmation (lags minutes to hours; not for speed) |
| 2 | `appstore` | Apple App Store charts JSON (keyless): Coinbase, Robinhood, Kraken, Crypto.com ranks in top free and Finance | poll 60 min | 3 | retail-mania gauge |
| 2 | `wikipedia` | Wikimedia pageviews API (keyless) for each universe asset's article | daily | 3 | attention |
| 2 | `exchange_blogs` | Coinbase blog, Gemini, Robinhood newsroom, Kraken blog (RSS) + Binance's official announcements Telegram channel (`t.me/s/`) | poll 60–120 s | 1 | listings, product launches, incidents |
| 2 | `central_banks` | ECB, Bank of England, Bank of Japan press RSS | poll 300 s | 1 | global rate shocks |
| 2 | `cot` | CFTC Commitments of Traders (Socrata API, keyless): CME BTC/ETH futures positioning | weekly (Fri) | 1 | positioning |
| 2 | `newsletters` | Substack/Ghost RSS of crypto research newsletters (list picked in Phase 0) | poll 15 min | 3 | narrative, context |
| 3 | `korea` | Upbit and Bithumb notices (headless if plain fetch is blocked) | poll 60 s | 1 | Korean listings and warnings |
| 3 | `etf_flows` | Farside spot ETF flow tables | daily after close | 2 | BTC/ETH ETF flows |
| 3 | `hacks` | SlowMist hacked database page | poll 15 min | 2 | exploits |
| 3 | `events_cal` | CoinMarketCal / token-unlock calendar pages, e.g. DefiLlama's public unlocks page (check ToS) | daily | 3 | scheduled events, unlocks |
| 3 | `google_trends` | Google Trends interest for universe assets (headless; heavily rate-limited, so hourly at most) | hourly | 3 | retail attention |
| 3 | `truth_direct` | truthsocial.com profile (headless), only if the RSS mirror lags or dies | poll 60 s | 1 | Trump posts first-hand |

**Verified, wave 1 crypto (Phase 0, 2026-10-26, from the trading server):**
- ✓ `kraken_ohlc`: WS v2 `ohlc` interval 1 works on the public socket; the snapshot holds only ~10 bars, so the 720-bar backfill uses REST OHLC interval 1.
- ✓ `stables`: USDT/USD and USDC/USD tickers stream on WS v2. ✓ `kraken_pairs`: REST AssetPairs.
- ✓ `status_kraken`, `status_coinbase`: Statuspage v2 `summary.json` (Kraken's is ~300 KB; poll 60 s is fine).
- ✓ `rss_core`: CoinDesk (`/arc/outboundfeeds/rss`, no trailing slash), The Block, Decrypt, Cointelegraph, Blockworks (`blockworks.com/feed`, Atom), The Defiant (`/api/feed`).
- ✓ `finnhub_crypto`: `/api/v1/news?category=crypto` with the key, ~90 items.
- ✓ `gov`: SEC press, litigation releases, trading suspensions (RSS); CFTC general press RSS; DOJ `api/v1/press_releases.json`; Fed `press_all.xml`; White House presidential actions feed (~575 KB); OFAC `ofac.treasury.gov/rss.xml`. ✗ Treasury press (`home.treasury.gov`) timed out from the server; left out for now.
- ✓ `gnews`: Google News RSS search with `when:1h`. ✓ `truth_social`: `www.trumpstruth.org/feed`. ✓ `macro`: ForexFactory `ff_calendar_thisweek.json`; `macro-calendar.json` built from the official FOMC, BLS (CPI, jobs, PPI through Dec 2027) and BEA (GDP, PCE; BEA publishes only ~2 months ahead) schedules.

**Verified, wave 2 crypto (Phase 6.1, 2026-10-26, from the trading server):**
- ✓ Coinbase Exchange `/products`; Kraken Futures `/derivatives/api/v3/tickers`; Hyperliquid `info` `metaAndAssetCtxs` (POST); Deribit DVOL and `BTC-PERPETUAL` ticker; DefiLlama `v2/chains` and stablecoins; Polymarket Gamma events (`tag_slug` crypto, fed-rates); Kalshi `KXFED`; alternative.me F&G; CoinGecko Demo trending (key); mempool.space fees and mempool; Etherscan v2 gas oracle (key); Solana Statuspage; GitHub release Atom (bitcoin, go-ethereum, agave, rippled, cardano-node); StockTwits BTC.X stream and trending; BLS v2 (key, POST) and FRED (key); Federal Register search; Coinalyze markets, funding and liquidations (key); ApeWisdom `all-crypto`; App Store top-free and Finance-genre JSON; Wikimedia pageviews; Kraken blog RSS; ECB, BoE and BoJ RSS; CFTC COT (Socrata; filter by market name, the loose match also hits "BITCOIN CASH PERP").
- ✓ `rss_more`: Bitcoin Magazine, CryptoSlate, DL News, Protos, CryptoBriefing, BeInCrypto, Bitcoinist, NewsBTC, The Daily Hodl, Unchained. ✓ Telegram previews: binance_announcements, WatcherGuru, whale_alert_io, wublockchainenglish, cointelegraph.
- ✓ Bluesky: Jetstream (`jetstream2.us-east`) streams posts for `wantedDids` and replays from a `cursor`; `resolveHandle` works keyless.
- ✗ GDELT DOC 2.0 answered 429 ("one request every 5 seconds") even when probed alone; the adapter keeps a ≥ 5 s gap and backs off. ✗ Coinbase blog RSS (403, Cloudflare), Gemini blog (HTML only), Robinhood newsroom (404): left out.
- Note: Kraken announced spot maintenance 2026-10-27 10:00–11:00 UTC (before the seed).

### 4.2 Stocks [S]

| Wave | id | Source | Transport | Tier | Gives |
| --- | --- | --- | --- | --- | --- |
| 1 | `alpaca_news` | Alpaca news WS `wss://stream.data.alpaca.markets/v1beta1/news` (`news: ["*"]`); REST `/v1beta1/news` every 20 s as fallback | stream | 2 | all-market Benzinga news with symbols |
| 1 | `alpaca_bars` | Existing IEX `MarketStream`: trades for the 30 layer-A symbols + **minute bars for every symbol (`bars: ["*"]`)** (§3.13) | stream | 1 | market-wide anomalies |
| 1 | `yahoo_stream` | Yahoo Finance streamer WebSocket (unofficial, keyless) for the scan universe (§3.13 layer C) | stream | 2 | tick-level breadth |
| 1 | `finnhub_ws` | Finnhub WebSocket trades (free key, ~50 symbols) for focus and top watchlist (§3.13 layer D) | stream | 1 | backup tick feed |
| 1 | `alpaca_snapshots` | Alpaca snapshots REST, batched, for the scan universe (§3.13 layer E) | poll 30–60 s (fallback only) | 1 | fallback breadth, daily volume |
| 1 | `movers` | Alpaca screener movers and most-actives | poll 60 s in session | 1 | movers outside the watched set |
| 1 | `edgar` | EDGAR current-filings Atom: 8-K, 6-K, 4, SC 13D/G, S-1, S-3, 424B*, NT 10-K/Q, 25-NSE; CIK→ticker from `company_tickers.json` | poll 30–60 s | 1 | material events, offerings, insiders, late filings, delistings |
| 1 | `halts` | Nasdaq Trader trade-halts RSS | poll 30 s in session | 1 | halts and resumptions |
| 1 | `pr_wires` | PR Newswire, Business Wire, GlobeNewswire, ACCESSWIRE, Newsfile RSS | poll 30–60 s | 1 (issuer's own release) | earnings, M&A, FDA, index changes (S&P DJI posts on PR Newswire) |
| 1 | `finnhub` | Finnhub market news (general, merger) + company news for held and watched symbols + earnings calendar | poll 60 s; calendar daily | 2 | news, earnings dates |
| 1 | `gov` | SEC press, litigation, trading suspensions; FTC press; DOJ press JSON; White House presidential actions; USTR press; Commerce BIS; Treasury and OFAC; Fed press and speeches; FDA press | poll 120–600 s | 1 | policy shocks, antitrust, FDA |
| 1 | `persymbol` | Google News RSS search + Yahoo Finance headline RSS for held and watched symbols | round-robin | 2/3 | symbol coverage |
| 1 | `massive_news` | Massive (formerly Polygon.io) `/v2/reference/news` (key; free 5 calls/min) | poll 60–90 s | 2 | multi-publisher news with tickers (Benzinga, Zacks, Motley Fool, GlobeNewswire…) |
| 1 | `truth_social` | Trump's Truth Social posts via the trumpstruth.org RSS mirror (same as crypto) | poll 30 s | 1 / 3 | tariffs, company call-outs, Fed pressure |
| 1 | `macro` | `macro-calendar.json` + ForexFactory weekly JSON | static + poll 300 s | 1/3 | release times and surprises |
| 2 | `vol_rates` | CBOE VIX (delayed JSON), CBOE put/call (daily), Treasury yield curve (daily XML) | poll 60 s / daily | 1 | risk-off signals |
| 2 | `odds` | Kalshi + Polymarket (Fed, CPI, recession, tariffs) | poll 120 s | 2 | odds swings |
| 2 | `fng` | CNN Fear & Greed (unofficial JSON) | poll 30 min | 3 | sentiment |
| 2 | `rss_outlets` | CNBC, MarketWatch, WSJ Markets, Seeking Alpha market currents + per-symbol XML, Investing.com, Nasdaq.com per-symbol RSS, Fox Business | poll 60–120 s | 2 | breadth |
| 2 | `fda` | openFDA drug approvals (daily) + FDA advisory committee calendar (HTML) | daily | 1 | FDA catalysts |
| 2 | `calendars` | Nasdaq earnings, IPO and dividend calendars (unofficial JSON) + Alpaca corporate actions | daily | 2 | scheduled events |
| 2 | `insiders` | openinsider.com latest purchases and cluster buys (HTML) | poll 10 min | 2 | insider buying |
| 2 | `finviz` | Finviz news page + insider page (HTML) | poll 120 s | 2/3 | aggregated headlines |
| 2 | `stocktwits` | StockTwits trending + symbol streams | poll 120 s | 3 | sentiment spikes |
| 2 | `telegram` | Public market-news channel previews (pick in Phase 0) | poll 30 s | 3 | speed |
| 2 | `macro_actuals`, `fedreg` | BLS + FRED at release; Federal Register (tariffs, rules) | event / poll 600 s | 1 | exact numbers, rules |
| 2 | `bluesky` | Bluesky Jetstream (no auth): curated finance and fast-news accounts + cashtag filter (mirrored adapter) | stream | 3 | fast social news |
| 2 | `wsb` | ApeWisdom (`all-stocks`, keyless) + Tradestie WallStreetBets top 50 with sentiment (keyless; verify it's still alive) | poll 15 min | 3 | retail attention and squeeze risk (Reddit workaround) |
| 2 | `gdelt` | GDELT DOC 2.0 (keyless, throttled): batched queries for held and watched company names | poll 5 min | 3 | global breadth and confirmation |
| 2 | `rss_more` | RTTNews, MarketScreener, Motley Fool, Zacks, Benzinga RSS, CNN Business, NYT Business, Axios Markets, Politico (policy), FT and Economist headlines | poll 60–300 s | 2/3 | breadth |
| 2 | `eia` | EIA API (key): weekly petroleum (Wed 10:30 ET) and natural gas (Thu 10:30 ET) reports, with surprise vs the prior week | event-driven | 1 | energy movers |
| 2 | `treasury` | TreasuryDirect auction results (keyless) | event-driven | 1 | weak auctions → yields spike |
| 2 | `cot` | CFTC Commitments of Traders (Socrata, keyless): ES/NQ/VIX futures positioning | weekly | 1 | positioning |
| 2 | `finra_short` | FINRA daily short-sale volume files (keyless CDN) for held and watched symbols | daily | 1 | short pressure, squeeze setups |
| 2 | `usaspending` | USAspending.gov API (keyless): large new federal contract awards to listed companies | poll 60 min | 1 | contract catalysts (defense, tech, health) |
| 2 | `clinicaltrials` | ClinicalTrials.gov API v2 (keyless): status changes on trials of held or watched biotechs | daily | 1 | trial halts and completions |
| 2 | `central_banks` | ECB, Bank of England, Bank of Japan press RSS (mirrored with crypto) | poll 300 s | 1 | global rate shocks |
| 2 | `appstore`, `wikipedia` | Robinhood/Webull app ranks; pageviews for held and watched companies | hourly / daily | 3 | retail attention |
| 3 | `options_flow` | Barchart unusual options activity (headless; check ToS) | poll 10 min | 3 | unusual flow |
| 3 | `fedwatch` | CME FedWatch probabilities (headless) | poll 30 min | 2 | rate odds |
| 3 | `nyse_halts` | NYSE halts page (if no feed) | poll 60 s | 1 | halts on NYSE names |
| 3 | `pdufa` | FDA PDUFA date calendars (check ToS) | daily | 3 | biotech catalysts |
| 3 | `ratings` | MarketBeat analyst rating changes and earnings pages (check ToS) | poll 10 min | 2 | upgrades and downgrades beyond Benzinga |
| 3 | `earnings_whispers` | Earnings Whispers calendar and whisper numbers (check ToS) | daily | 3 | expectations |
| 3 | `congress` | Capitol Trades (delayed congressional trades; check ToS) | daily | 3 | slow, low-weight signal |
| 3 | `google_trends` | Google Trends for held and watched names (headless, hourly at most) | hourly | 3 | retail attention |
| 3 | `truth_direct` | truthsocial.com profile (headless), only if the mirror lags | poll 60 s | 1 | first-hand Trump posts |

**Verified, wave 1 stocks (Phase 0, 2026-10-26, from the trading server; all 31 sources `ok` in the heartbeat at 02:00Z on 10-27):**
- ✓ `edgar`: current-filings Atom per form group (8-K, 6-K, NT 10-K/Q, 424B*, SC 13D/G, 25-NSE) with `SEC_USER_AGENT`. Entry summaries carry the 8-K item numbers (no index fetch needed); CIK → ticker from `company_tickers.json`, reloaded daily.
- ✓ `halts`: Nasdaq Trader `rss.aspx?feed=tradehalts`. The feed also lists halts that are years old; items older than 2 days are dropped.
- ✓ `pr_wires`: PR Newswire only. ✗ GlobeNewswire (403), ACCESSWIRE (404), Newsfile and Business Wire (empty) from the server; left out until they can be reached.
- ✓ `finnhub`: general and merger news, and company news for held and focus symbols. ✓ `massive_news`: `api.massive.com/v2/reference/news` with the key.
- ✓ `gov`: SEC press, litigation, trading suspensions; FTC; DOJ JSON; White House presidential actions; USTR; BIS; OFAC; Fed press and speeches; FDA press.
- ✓ `persymbol`: Google News RSS search and Yahoo headline RSS. ✓ `truth_social`, ✓ `macro` (same as crypto).
- ✓ `alpaca_news`: REST `/v1beta1/news` every 20 s is primary as built; the news WebSocket isn't used. ✓ `movers`: screener movers and most-actives in session.
- `alpaca_bars`: `bars: ["*"]` is sent on its own on the IEX connection and was not rejected; bar flow can only be confirmed in session (0.9).

**Verified, wave 2 stocks (Phase 6.1, 2026-10-26, from the trading server):**
- ✓ CBOE delayed VIX quote JSON and VIX history CSV; Treasury daily yield-curve XML (slow: ~18 s); Kalshi `KXCPI`, `KXRECSSNBER` (and `KXFED`, see crypto); Polymarket economy events; CNN Fear & Greed graph data (browser User-Agent); openFDA drugsfda (key) and the FDA advisory-committee calendar page; Nasdaq earnings, IPO and dividend calendar JSON (browser User-Agent); openinsider latest purchases and Finviz news and insider pages (HTML); StockTwits trending; Federal Register search; ApeWisdom `all-stocks`; Tradestie WallStreetBets (alive); EIA v2 weekly petroleum and natural-gas storage (key); TreasuryDirect auctioned securities JSON; CFTC COT for E-mini S&P 500, Nasdaq-100 and VIX; FINRA daily short-volume files; USAspending award search (POST); ClinicalTrials.gov v2; App Store Finance genre JSON.
- ✓ `rss_outlets` / `rss_more`: CNBC, MarketWatch, WSJ Markets, Seeking Alpha market currents, Investing.com, Nasdaq per-symbol RSS (browser User-Agent), Fox Business, RTTNews, Benzinga, CNN Business, NYT Business, Politico economy, FT markets, The Economist. Telegram previews: WalterBloomberg, FinancialJuice, marketfeed. Bluesky as for crypto.
- ✗ MarketScreener RSS (403) and the Motley Fool feed (needs a partner API key): left out. CBOE's daily put/call ratio has no simple endpoint; VIX covers risk-off for now.

### 4.3 Considered and left out

| Source | Why |
| --- | --- |
| NewsAPI.org, GNews, Marketaux, NewsData.io, TheNewsAPI, Mediastack, World News API, Webz.io, Alpha Vantage, FMP free | Free tiers are tiny daily or monthly quotas, or delayed |
| CryptoPanic | No longer free (owner, 2026-10-26) |
| CoinDesk Data API (formerly CryptoCompare) | Free tier retired in May 2026; CoinDesk's RSS is still used |
| Bing News Search API | Retired by Microsoft in 2025 |
| Real-time stock prices from Tiingo, Twelve Data, Massive free, Databento, Alpha Vantage | Free tiers are unclear, end-of-day only, tiny quotas, or trial credits. No free provider offers unlimited real-time full-market data; §3.13 layers free feeds instead |
| X/Twitter API or scraping | Paid API; scraping needs a login, breaks ToS and risks bans. Grok's `x_search` covers X |
| Reddit | Self-service API closed in Nov 2025; new apps need approval. **Optional:** the owner can apply now and add it later |
| Binance, Bybit, OKX APIs | Geo-block US IPs. Their listing news reaches the RSS feeds and Telegram within minutes |
| Whale Alert API, Coinglass, Glassnode, CryptoQuant, LunarCrush, Santiment, Tokenomist API, DefiLlama Pro (hacks, unlocks) | Paid |
| DefiLlama unlocks page, CoinMarketCal, Truth Social (direct), Barchart unusual options, CME FedWatch, NYSE halts page, Earnings Whispers, FDATracker, Capitol Trades | Phase 7.4 (2026-10-26): the terms forbid bots or data mining, or the site sits behind a bot wall (CoinMarketCal, Capitol Trades, whose API robots.txt disallows everything). FedWatch and NYSE halts would add little anyway: Kalshi and Polymarket price the same Fed meetings, and the Nasdaq halts feed is cross-market |
| Farside ETF flows, Benzinga FDA calendar | Behind a Cloudflare bot challenge, which the bots don't try to get past |
| Upbit notice pages | robots.txt disallows all crawlers; the official Open API market list is used instead |
| Google Trends | Unofficial and heavily throttled; Wikipedia, App Store, ApeWisdom and StockTwits already cover attention (owner, 2026-10-26) |
| BioPharmCatalyst | A JavaScript-only calendar; RTTNews has the same PDUFA dates in plain HTML |
| House/Senate Stock Watcher | The S3 buckets are gone (403); the House Clerk's own files are used instead |

---

## 5. Tasks

### Phase 0: Verify sources and get keys (≈ 1 h; can run alongside Phase 1)

- [x] 0.1 **Owner:** get the keys in §3.10, add them to the server `.env` in both repos, and restart nothing yet.
- [x] 0.2 [both] From the trading server, check every **wave-1** source: reachable, auth, rate limits, payload shape. Use throwaway scripts outside the repos. Mark ✓ or ✗ with notes in a **Verified** list under §4. Check waves 2 and 3 at the start of their phases. *(Done: see the Verified lists under §4.1 and §4.2.)*
- [x] 0.3 [S] Alpaca news WS works on the current plan **while** `v2/iex` and `trade_updates` are connected with the same key. If it doesn't, REST polling every 20 s becomes primary. *(As built: REST every 20 s is primary; the WS isn't used.)*
- [x] 0.4 [C] Kraken WS v2 `ohlc` interval 1 on the existing socket; the USDT/USD and USDC/USD tickers exist.
- [x] 0.5 [S] EDGAR: do Atom summaries carry 8-K item numbers? If not, fetch the filing index. Confirm the User-Agent format and `company_tickers.json`. *(Yes, the summaries list the items; `SEC_USER_AGENT` and `company_tickers.json` work.)*
- [ ] 0.6 [S] Benzinga content via Alpaca on a **public** page: confirm Alpaca's terms allow it. If they don't, the public view shows source + link only for those items, and the owner view shows full titles. *(As built: only Benzinga headlines and links are stored, never the summaries. The terms check is still open.)*
- [ ] 0.7 [both] MongoDB Atlas: check the cluster tier and free storage. Estimate items per day × about 1.5 KB × `retention_days`. If storage is tight, lower `retention_days` or tighten the relevance filter. *([C] 2026-10-26: each bot has its own cluster, MongoDB 8.0; crypto data is 2.8 MB. The tier isn't visible from the driver, so the free 512 MB tier is assumed and `retention_days` defaults to 30, not 90. Raise it from Admin if the cluster is bigger.)*
- [x] 0.8 [both] Save 2–3 real payloads per wave-1 source as test fixtures in `apps/engine/test/fixtures/wire/` (keys stripped). *(Done 2026-10-26 in both.)*
- [x] 0.9 [S] Stock price layers (§3.13): *(Checked 2026-10-26 except `bars: ["*"]` flow in session; results in §3.13.)*
  - **Alpaca:** on the free plan, does `bars: ["*"]` work on the `v2/iex` connection together with the 30-symbol trades and quotes? How many bars arrive per minute during the session? This is the most important check: if it works, it is the breadth layer.
  - **Yahoo streamer:** connects from the server; how many symbols one connection accepts; the message rate; the protobuf schema (save fixtures).
  - **Finnhub WS:** the free symbol limit.
  - **Alpaca snapshots:** the maximum symbols per call and the rate limit.

  Record the results in §3.13.

### Phase 1: One-time seed buys (DEADLINE: deployed tonight; runs 2026-10-27 09:45 ET)

Owner decisions (2026-10-26):
- About **$2,000 per bot**, once. Never again unless explicitly requested.
- It runs **whether or not** the bot already holds positions.
- **What to buy is decided by research that morning**, not in advance. Grok sees the owner's earlier lean as a reference only: crypto 55% BTC / 35% ETH / 10% SOL; stocks an index ETF such as SPY or QQQ.

- [x] 1.1 [both] `packages/core/src/commands.ts`: `seed.schedule { amount_usd: 100–10,000, at: ISO datetime, force?: boolean }` and `seed.cancel`. Validated by both web and engine, like every command.
- [x] 1.2 [both] `packages/core/src/db.ts`: collection `seed_runs`. Each run is `{ _id, status: "scheduled" | "running" | "done" | "failed" | "canceled", amount_usd, at, created_by, cycle_id, result: { allocations, orders, notes } | null, error, done_at }`. The engine **refuses `seed.schedule` when any run is `done`** unless `force: true`, which is how "never again unless requested" is enforced. One `scheduled` run at a time.
- [x] 1.3 [C] `engine.ts` `schedule()`: when a run is due (`at` ≤ now), nothing is running, and the engine is running → `runCryptoCycle(ctx, { kind: "seed", trigger: "seed", seed: { amountUsd } })`. The seed path in `crypto-cycle.ts`:
  - **Candidates:** universe symbols with fresh quotes, with daily-trend hints: stop = 2.5 daily ATR, bounded by `min/max_stop_pct`; target 3R; horizon 2160 h.
  - **Research:** always `full` Grok research with a seed variant of the research prompt (long-term outlook for the candidates, macro and flows), plus the dossier when the wire is running.
  - **Decision:** a new `seedAllocationSchema` `{ allocations: [{ symbol, weight_pct, thesis, invalidation, stop_loss, take_profit, horizon_hours }] (1–4, weights sum ≤ 100), rationale }`, with repair and normalization like the cycle report. The prompt has a `# ONE-TIME SEED` section: the amount; long-term core holds (weeks to months); the owner's earlier lean as a reference only.
  - **Execution:** notional = amount × weight, rounded to the lot; strategy `daily_trend`. It runs through `evaluateCryptoEntry` with a new `ownerDirected: true` option that skips only the conviction, net-edge and reward:risk gates. Every other gate and cap still applies (running, kill switch, venue, reconciled, quote age, spread, exposure caps, cash, lot minimums). Positions are then managed like any `daily_trend` position.
  - **Recording:** decision docs carry `trigger_kind: "seed"`. A Discord success alert lists the allocation, and `seed_runs` gets the result.
- [x] 1.4 [S] `engine.ts` `schedule()`: run only in the regular session after `open_buffer_minutes`. At 09:45 ET → `runCycle(ctx, { phase: "intraday", trigger: "seed", seed: { amountUsd } })`.
  - **Research:** research gets a seed task line (best long-term core holding for the amount: index ETFs vs large caps, the macro backdrop).
  - **Prompt:** the decision prompt gets a `# ONE-TIME SEED` section: allocate about the amount to 1–3 core holds; `buy` decisions only; horizon `multi_day`; stop about 7–8% (within `min/max_stop_pct`).
  - **Normalization:** keep only `buy` actions, with total notional ≤ amount + 5%.
  - **Execution:** go **through `executeDecisions()`**, so the position plan doc is written exactly as for AI buys. Do **not** hand-write plans or place orders outside the engine, for two reasons. First, `ensureProtection` adopts a position that has no plan using the 2.5% default stop. Second, the 10-minute stale-plan cleanup deletes a plan written before its fill.
  - Respect the normal risk checks (`min_conviction`, `max_position_pct`, cash reserve). If the prompt's conviction is below the minimum, the buy is rejected and the run is marked `failed` with the reason.
- [x] 1.5 [both] A seed run is a single attempt: if Grok or the risk engine fails, mark it `failed`, alert, and don't retry automatically. The owner can re-schedule (needs `force` only if a run is `done`).
- [x] 1.6 [both] Admin page: a **"One-time seed"** card showing the current or last run (status, time, allocation, orders). It has a schedule form (amount, time), defaulting to $2,000 at the next 09:45 ET. After a `done` run, a "force a new seed" checkbox appears behind a confirm dialog.
- [x] 1.7 [both] Tests:
  - Command validation and the done/force refusal.
  - The crypto seed path with the mocked AI: allocation → sized orders → risk with `ownerDirected`.
  - The stock seed: buys only, the notional cap, and the plan written via `executeDecisions`.
- [ ] 1.8 Deploy both engines and dashboards tonight. **Owner:** schedule each seed from Admin for **2026-10-27 09:45 ET**, then check that `seed_runs` shows `scheduled` in both databases. *(Both engine containers deployed 2026-10-26; dashboards deploy on push to `main`. Waiting on the owner to schedule.)*

**As built (differences from the text above):**
- Lifecycle lives in the mirrored `apps/engine/src/state/seed-runs.ts` (schedule, cancel, claim, missed, interrupted). `seed.schedule` expires like other risk-increasing commands (10 min) and rejects times more than 10 min in the past or 30 days ahead.
- A run that can't start in time is failed as **missed**, never run late: [C] 120 min after `at`; [S] at the start of the closing window on its own trading day (or at once if that day has passed or the market is closed). A run left `running` by a restart is failed at boot.
- [C] The seed cycle is `orchestrator/seed.ts`, reached through `runCryptoCycle(ctx, { kind: "seed", … })`. `CycleRequest` replaced the positional arguments (all cycles now record `kind`). Candidates exclude held pairs (adding is disabled). The seed schema also carries a 0–100 `conviction` for the record; a seed stop outside `min/max_stop_pct` falls back to the bounded hint.
- [S] The seed is an intraday cycle with `seed` set: SPY and QQQ join the context as requested symbols, `bot/seed.ts` keeps ≤ 3 buys (multi_day, total ≤ amount + 5%) and fills in core-hold exits when Grok's are missing or out of range (stop ≈ 7.5% within the range, target 2.5× the stop distance). Execution is `executeDecisions` with `triggerKind: "seed"`; every normal risk check applies.
- The Admin card is the mirrored `apps/web/app/admin/seed-card.tsx`; it shows times in New York time.

**Done when:** both seeds are scheduled. **Tomorrow, after 09:45 ET:** check both runs are `done` and the positions exist with stops, and write the result in the Progress log.

### Phase 2: Wire core, settings and storage

- [x] 2.1 [both] `packages/core/src/wire.ts`: categories (per bot), tiers, `WireItemDoc`, `WireTriggerDoc`, `WireSourceHealth`, `EventFocus`, `TriggerRequest`. *(Done 2026-10-26 in both.)*
- [x] 2.2 [both] `packages/core/src/db.ts`: `wire_items`, `wire_triggers` + `INDEXES`; `EngineStatusDoc.wire`; the optional cycle, decision and research fields; `AiTask` `"research_gap"`. `apps/engine/src/db/mongo.ts`: expose the new collections. *(Done 2026-10-26 in both.)*
- [x] 2.3 [both] `packages/core/src/settings.ts`: `wire` section and defaults (§3.10), plus a superRefine for ascending thresholds. Tests: defaults validate, and an **old stored settings doc without `wire` migrates**. *(Done 2026-10-26 in both.)*
- [x] 2.4 [both] `packages/core/src/events.ts`: `wire.item`, `wire.notable`, `wire.dossier`, `wire.trigger`, `wire.source`, `seed.*`. *(Done 2026-10-26 in both.)*
- [x] 2.5 [S] Add `apps/engine/src/util/http.ts` (copy from crypto). [both] Treat `304` as "no change" (`okStatuses` option); add a default User-Agent. *(Done 2026-10-26 in both.)*
- [x] 2.6 [both, mirrored] `wire/types.ts`, `limiter.ts`, `normalize.ts`, `cluster.ts`, `severity.ts`, `calendar.ts` + `macro-calendar.json`, and every `kinds/*` except `headless`. Add `fast-xml-parser` and `cheerio` (exact versions). *(Done 2026-10-26 in both.)*
- [x] 2.7 [both, mirrored] `wire/wire.ts`: the `Wire` class. *(Done 2026-10-26 in both.)*
  - **Catalog:** load it, applying `disabled_sources` and the key gates.
  - **Sources:** lifecycle, each isolated (try/catch, backoff, auto-degrade on repeated 403/429).
  - **Pipeline:** normalize → cluster → tag → classify → relevance filter → score → persist (a duplicate-key error means already seen) → emit → policy.
  - **Notable flag:** compute it with the mirrored `wire/notable.ts` (§3.12), from the item plus the engine's current held, focus and watchlist symbols. Add `markNotable(itemIds, reason)`, which sets `notable: true`, adds the reason and emits `wire.notable`. Policy and decision processing call it later.
  - **Clustering memory:** a bounded 24 h in-memory index.
  - **Settings:** follows `settings.onChange`.
  - **Outputs:** `onTrigger` and `health()`.
  - **Engine safety:** no exception ever reaches the engine.
- [x] 2.8 [C] `wire/lexicon.ts`: crypto categories and aliases. BTC matches bitcoin, xbt, $btc; ETH matches ethereum, ether; and so on. Ambiguous tickers (LINK, DOT, SOL, ADA…) need the full name or a cashtag. [S] `wire/lexicon.ts`: stock categories, the 8-K item → category map, and the cashtag/company-name aliases (held, watched). *(Done 2026-10-26 in both.)*
- [x] 2.9 [both] Wire it in: `main.ts` constructs the `Wire` after market data starts; `engine.ts` starts and stops it and writes the heartbeat `wire` block. Update `env.ts`, `secretValues()` and `.env.example`. *(Done 2026-10-26 in both.)*
- [x] 2.10 [both] Tests: *(Done 2026-10-26 in both.)*
  - Normalize, cluster, severity, lexicon (false positives such as "link", "dot", "sol"), the relevance filter.
  - Each `kinds/*` against fixtures, including 304 handling.
  - The pipeline on `mongodb-memory-server`: dedupe across a restart, and **old items never trigger**.

**Done when:** the engine boots with the wire in `live` mode and an empty catalog without errors.

### Phase 3: Wave-1 sources and anomaly detectors

- [x] 3.1 [C] `wire/catalog.ts`: every wave-1 crypto source in §4.1. Custom adapters `sources/kraken-pairs.ts` and `sources/finnhub.ts` (shared shape with stocks).
- [x] 3.2 [S] `wire/catalog.ts`: every wave-1 stock source in §4.2. Custom adapters: *(As built: `sources/alpaca.ts` holds `alpaca_news` (REST) and `movers`; Finnhub is plain `json` catalog entries; plus `sources/halts.ts`. The PR wires that failed from the server are left out, see §4.2.)*
  - `sources/alpaca-news.ts`: WS modeled on `alpaca/market-stream.ts`, plus the REST fallback.
  - `sources/edgar.ts`: forms, 8-K items, the CIK→ticker map (daily, cached in `cache`).
  - `sources/movers.ts`.
  - `sources/finnhub.ts`.
- [x] 3.3 [both, mirrored] `wire/anomaly.ts` (§3.6). *(Done 2026-10-26 in both.)*
- [x] 3.4 [C] `venues/kraken/ws.ts`: subscribe to `ohlc` interval 1 for the universe and to the stablecoin tickers. Keep the stablecoins out of `hub.universe` and away from any trading path. `market/hub.ts`: feed bars into the detector; backfill 720 one-minute bars on boot. Depeg and BTC market-shock detectors.
- [x] 3.5 [S] Stock price coverage (§3.13): *(Done 2026-10-26. As built: `market/scan-universe.ts` (cached per New York day, rebuilt at boot or after midnight ET rather than before premarket; SIP daily bars for dollar volume); `market/price-board.ts` merges A–E into 1-minute bars (volume from IEX only, NaN otherwise); `market/yahoo-stream.ts` reads the four PricingData fields it needs with a small hand-written protobuf reader instead of `protobufjs`; `market/finnhub-stream.ts`; `market/price-layers.ts` assigns symbols and runs the snapshot fallback. Each layer B–E is a wire source (`price:alpaca_bars`, `price:yahoo`, `price:finnhub`, `price:snapshots`) with a `detail` line, so health shows in the heartbeat and Admin and a layer can be switched off with `disabled_sources`. The mirrored detector keeps its time map only for the reference and gained `forget()`. Still to confirm at the open: bars flow on layer B.)*
  - `market/scan-universe.ts`: the daily builder (assets → snapshots → filters → top `scan_max_symbols`), cached in `cache`, rebuilt before premarket. Movers are added during the session.
  - `alpaca/market-stream.ts`: subscribe `bars: ["*"]` alongside the existing trades and quotes, and parse `T: "b"` messages. Keep the 30-symbol trades/quotes logic unchanged.
  - `market/yahoo-stream.ts`: Yahoo streamer client. One connection, chunked subscribe, protobuf decode (vendor the `PricingData` `.proto` and use `protobufjs`, exact version), reconnect and backoff.
  - `market/finnhub-stream.ts`: Finnhub WS client (≤ 50 symbols, focus first).
  - `market/price-board.ts`: merges the layers, builds 1-min bars per symbol with layer precedence, tracks per-layer health and disagreement, feeds `wire/anomaly.ts`, and backfills today's 1-min bars from REST for the scan universe in batches.
  - Event cycles swap their focus symbol into layer A before deciding.
  - Use SPY as the reference, ignore `open_buffer_minutes`, and treat SPY/QQQ moves as market shocks.
  - Heartbeat: per-layer state, symbol counts and lag. Admin shows them.
  - Settings `[S] wire.scan_max_symbols` (default 1,500) and `wire.scan_min_dollar_volume` (default $20M).
  - Tests: `PriceBoard` precedence and disagreement, bar building from mixed layers, the universe builder filters, Yahoo protobuf decoding against a fixture, and the `bars` message parsing.
- [x] 3.6 [both] Tests: a parser test per adapter against fixtures; anomaly z-scores, warm-up, re-arm and the residual move on synthetic bars. *(Done 2026-10-26 in both.)*

**Done when:** on the deployed engines, every wave-1 source shows as healthy in the heartbeat and items are flowing.

### Phase 4: Dossier, triggers, event cycles, research modes (the wire starts acting)

- [x] 4.1 [both, mirrored core] `wire/dossier.ts` (§3.8). *(Done 2026-10-26 in both.)*
- [x] 4.2 [C] `ai/prompts.ts`:
  - The `# WIRE` section and its rule text.
  - The `# EVENT` section.
  - `cryptoGapFillPrompt`.
  - Bump to `crypto-v4`.
- [x] 4.3 [S] `ai/prompts.ts`: *(Done 2026-10-26: `PROMPT_VERSION` `2026-10-27.wire-1`.)*
  - The `# WIRE` section; the dossier replaces `context.news` in `market/context.ts`.
  - The `# EVENT` section.
  - `researchGapFillPrompt`.
  - Bump `PROMPT_VERSION`.
- [x] 4.4 [C] `wire/policy.ts` (§3.5): rules, gating, and `wire_triggers` docs.
- [x] 4.5 [S] `wire/policy.ts`: market-hours aware, with off-hours `priority` items and immediate alerts. *(As built: the stock rules sit in `wire/policy.ts` and the gates are the mirrored `wire/trigger.ts`. Off-hours triggers are recorded as suppressed ("market closed"); held-negative, halt-resumption and policy-shock ones alert at once. There is no separate `priority` flag: the next phase's dossier ranks the items by severity.)*
- [x] 4.6 [C] `engine.ts` + `orchestrator/crypto-cycle.ts`:
  - `requestEventCycle`, the queue and draining.
  - Caps and the minimum gap.
  - `CycleRequest`, the event path, the research mode choice (§3.9) and skip reasons.
  - The dossier URLs added to `sourceUrls`.
  - The new fields on cycles and decisions.
- [x] 4.7 [S] `engine.ts` + `bot/cycle.ts` + `market/context.ts`: *(Done 2026-10-26. As built: the event queue drops triggers that waited more than 30 min, recording them as suppressed; the one-time seed always gets full research.)*
  - Event intraday cycles; `buildContext(..., { scope: "event" })`.
  - The research mode choice.
  - The allowed URLs.
  - Focus symbols added to the stream subscriptions.
  - The new fields.
- [x] 4.8 [both] `ai/budget.ts`: the `reservePct` option on `canAfford`. *(Done 2026-10-26 in both.)*
- [x] 4.9 [C] `emergency_action` (`review` / `tighten_stop` / `exit`) per §3.7. [S] `review` / `exit`. *(Done 2026-10-26 in both.)*
- [x] 4.10 [both] Owner command `wire.replay { item_id }`: re-runs a stored item through the policy and returns the result without starting a cycle. Used for tuning. *(Done 2026-10-26 in both.)*
- [x] 4.12 [both] Live-page data from the engine (§3.12): *(Done 2026-10-26 in both.)*
  - Emit `wire.dossier` (with `cycle_id`) whenever a dossier is built for a cycle.
  - Fired or queued triggers call `markNotable(ids, "triggered")`.
  - After decision normalization, map cited evidence URLs to wire item ids and call `markNotable(ids, "cited")`.
  - Tests: the notable rules (each reason; stale, duplicate, unconfirmed and low-severity items stay off), and `markNotable` emits once per reason.
- [x] 4.11 [both] Tests: *(Done 2026-10-26 in both.)*
  - Each policy rule fires or is suppressed with the right reason.
  - Caps, cooldowns and the gap; old items never trigger.
  - The confirmation gate blocks entries but never reviews.
  - The budget reserve math.
  - An event cycle with the mocked AI reaches the risk engine.
  - Research mode selection and skip reasons; prompts with the fenced dossier; normalization accepts dossier URLs and drops invented ones.
  - Stocks: market-closed queueing.

**Done when:** deployed. The first real trigger on each bot produces an event cycle, and its decision lands ≤ 90 s after the item's `first_seen_at`, checked from `wire_triggers` and the cycle doc.

### Phase 5: Research page ("AI research" / "Our research") and Live page (both apps, public)

- [x] 5.1 [both] `apps/web/app/research/page.tsx` gets two clearly separate sections or tabs: *(Done 2026-10-26 in both.)*
  - **AI research:** the existing Grok memo list, unchanged except for a mode badge (full / gap-fill / skipped).
  - **Our research:**
    - A live list of news engine items: time, severity badge, category, symbols, source and tier, title linking out, move since.
    - Filters by symbol, category, severity and source.
    - A **Triggers** sub-list (fired, queued and suppressed, with the reason and a link to the cycle).
    - A compact **source health** strip.
- [x] 5.2 [both] `apps/web/app/research/[id]/page.tsx`: the detail page keeps the sections separate too. **AI research** shows the Grok memo, sources and queries. **Our research** shows the dossier items the decision saw and the trigger that started the cycle, if any. *(Done 2026-10-26 in both.)*
- [x] 5.3 [both] Live updates: render `wire.item` (severity ≥ annotate) and `wire.trigger` in the activity feed (`components/live/*`), and in the "Our research" list as they arrive. *(Done 2026-10-26 in both.)*
- [x] 5.4 [both] Admin: per-source health in `system-health.tsx`; a `wire` section in `settings-form.tsx` (mode, research mode, thresholds, caps, reserve, emergency action, disabled sources). *(Done 2026-10-26 in both.)*
- [x] 5.5 [both] Decision pages: a "Triggered by" line linking to the items. *(Done 2026-10-26 in both. [S] has no decision page: the line sits in the rationale cell of the decisions table, which every stock page with decisions uses.)*
- [x] 5.6 [both] Analytics: *(Done 2026-10-26 in both.)*
  - Outcomes by `trigger_kind` (scheduled / event / seed) and by wire category.
  - The trigger funnel: items → triggers → cycles → approved → filled → outcome.
  - Median latency from item to decision.
  - Grok research spend per day before and after.
- [x] 5.7 [both] Data access in `apps/web/lib/data.ts` [C] and `apps/web/lib/queries.ts` [S]. Apply the Phase 0.6 rule for Benzinga items in the public view. *(Done 2026-10-26 in both.)*
- [x] 5.8 [both] Live page, cycle trail (`components/live/cycle-trail.tsx`): handle `wire.dossier` with a new **"Our research"** step before the AI research step (top 5 + "show all"). When the cycle doc has `kind: "event"`, show a **"Triggered by"** banner (rule + item) at the top. *(Done 2026-10-26 in both.)*
- [x] 5.9 [both] Live page (`app/live/page.tsx`): a new **"News that matters"** card (§3.12). Server-render the last 6 h of `notable: true` items (≤ 10). The client merges live `wire.item` / `wire.notable` events where `notable` is true, shows why-chips from `notable_reasons`, and has the empty state. Keep the existing grid; on large screens it goes as a full-width row between "Latest cycle / Activity" and "Recent cycles". *(Done 2026-10-26 in both.)*
- [x] 5.10 [both] Activity feed (`components/live/live-ui.tsx`): icons and details for `wire.trigger`, `wire.item` and `wire.notable`. Show only fired or queued triggers and notable items, and add a "News" entry to `FILTERS`. Recent cycles list: show an "event" badge and the trigger rule for event cycles. *(Done 2026-10-26 in both.)*

**Done when:** a logged-out visitor sees both sections on the Research page. The Live page shows only notable items, the dossier step and "Triggered by" banners. New items appear live on both pages.

### Phase 6: Wave-2 sources

- [x] 6.1 [both] Verify the wave-2 sources (as in 0.2) and save fixtures. *(Done 2026-10-26: see the wave-2 Verified lists under §4.1 and §4.2; raw samples feed the fixtures.)*
- [x] 6.2 [C] Add every wave-2 source in §4.1: catalog entries plus custom adapters for `coinbase_ws`, `kraken_futures`, `hyperliquid`, `deribit`, `coinalyze`, `defillama` (TVL-drop detector), `odds`, `macro_actuals`, `apewisdom`, `gdelt`, `appstore` and `wikipedia`. Add the `coinbase_premium`, `funding_extreme`, `tvl_drop`, `odds_swing` and `sentiment_spike` logic to the policy. Liquidation cascades from Coinalyze go into `funding_extreme`, or a new `liquidation_cascade` category (base 50). *(Done 2026-10-26. As built: the mirrored `wire/metrics.ts` (`MetricWatcher`: level, change and spike rules, first reading a baseline, one firing per excursion) drives every stateful source. Open-interest and DVOL jumps count as `funding_extreme`; fee and gas spikes as `volume_shock`; stablecoin supply and COT as low-severity `general`. Coinbase blog, Gemini and Robinhood are left out (see §4.1); GDELT is enabled but 429s from the server and auto-degrades. Federal Register notices are weighted by document type and paperwork is dropped.)*
- [x] 6.3 [S] Add every wave-2 source in §4.2: catalog entries plus custom adapters for `vol_rates`, `odds`, `fda`, `calendars`, `insiders`, `finviz`, `macro_actuals`, `wsb`, `gdelt`, `eia`, `treasury`, `cot`, `finra_short`, `usaspending`, `clinicaltrials`, `appstore` and `wikipedia`. *(Done 2026-10-26. As built: sponsors, applicants and contract recipients are mapped to tickers through the SEC company directory plus about 40 subsidiary aliases (`sources/companies.ts`); one that maps to no listed company is skipped. Odds swings start a market review only when critical and something is held; insider buying (including `insider_cluster`, 2+ insiders within 5 days), attention spikes and our own readings (VIX, yields, weak auctions, EIA, COT, short volume) only annotate the dossier. Treasury auctions count as weak on bid-to-cover or dealer take, since there is no when-issued yield to measure a tail. Left out: MarketScreener (403), Motley Fool (partner key), CNN Business (RSS frozen since 2018), CBOE put/call (no endpoint; the Fear & Greed item carries CNN's 5-day average). GDELT 429s and auto-degrades, as in crypto.)*
- [x] 6.4 [both, mirrored] `wire/sources/bluesky.ts`: Jetstream client (`wantedCollections=app.bsky.feed.post`, `wantedDids` from the catalog's account list, resuming from a `cursor` saved after each event). Keyword, cashtag and alias filter before items enter the pipeline. Fall back between the jetstream1 and jetstream2 hosts. *(Done 2026-10-26 in both. As built: the cursor is kept in memory, so a reconnect resumes exactly and a restart replays 10 minutes as backfill; posts that are replies or miss the bot's keyword filter are dropped.)*
- [x] 6.5 [both] Telegram channel list (including Binance's official announcements channel), Bluesky account list, newsletter list and StockTwits symbols in the catalogs. The owner approves the account and channel lists. *(Telegram and Bluesky lists approved and live in both catalogs (§8.9); StockTwits uses trending plus BTC.X/ETH.X; newsletters approved and live in both (§8.10), done 2026-10-26.)*
- [x] 6.6 [both] Parser tests per adapter. *(Done 2026-10-26 in both: crypto 169 tests, stocks 495.)*

**Done when:** all wave-2 sources are healthy, or disabled with a written reason.

### Phase 7: Wave-3 (headless scraping)

- [x] 7.1 [both] A `scraper` sidecar: `apps/scraper/` (mirrored), a ~100-line Node HTTP server on the official Playwright image. `POST /render { url, wait_for, timeout_ms }` → `{ html, status }`. It reuses one browser, restarts it every 6 h, caps concurrency at 2, and listens on the internal Docker network only (no host port). Add it to `docker-compose.yml`. The engine's `kinds/headless.ts` calls it, and a dead sidecar only degrades those sources. *(Done 2026-10-26 in both. As built: `apps/scraper/server.mjs` on `mcr.microsoft.com/playwright:v1.64.1-noble` with `playwright-core` 1.64.1, outside the pnpm workspace with its own npm lockfile. It queues up to 16 renders, skips images, media and fonts, and can return the page's own JSON responses (`capture`) instead of the HTML. The container is read-only with no capabilities and a 768 MB limit, and idles at about 140 MB. Engine side: the mirrored `kinds/headless.ts`, `SourceSpec.render`, and `SCRAPER_URL` (set in compose); headless sources stay off without it, and a site's own 403 or 429 degrades the source as for a plain fetch. The sidecars run on the server; each engine picks up `SCRAPER_URL` at its next deploy.)*
- [x] 7.2 [C] Wave-3 crypto sources: `korea`, `etf_flows`, `hacks`, `events_cal`, `google_trends`, `truth_direct` (only if needed). *(Done 2026-10-26. As built: `korea:upbit` (Open API market list, diffed: investment warnings, caution flags and KRW delistings), `korea:bithumb` (official notices: delistings, caution designations and liftings, wallet pauses; promotions dropped) and `korea:bithumb_alerts` (per-market trading alerts), universe coins only, with the Korean ticker in parentheses mapped by the adapter. Designations and delistings are `venue_status` (reviews a holding); everything else is low-severity context. `hacks:slowmist` (plain HTML): a hack of a universe asset itself, or $10M+ lost as market-wide; the chain a protocol runs on is never tagged. All plain JSON or HTML. Skipped (§4.3): `etf_flows` (Farside's Cloudflare challenge), `events_cal` (DefiLlama terms; CoinMarketCal behind a challenge), `google_trends` (owner), `truth_direct` (terms).)*
- [x] 7.3 [S] Wave-3 stock sources: `options_flow`, `fedwatch`, `nyse_halts`, `pdufa`, `ratings`, `earnings_whispers`, `congress`, `google_trends`, `truth_direct` (only if needed). *(Done 2026-10-26: `ratings:marketbeat` and `earnings:marketbeat` (HTML, every 15 min on weekdays 06:00–19:00 ET; analyst actions and reported EPS/revenue vs estimates for tracked stocks; rows have no dates, so a row's identity is the action itself) and `pdufa:rttnews` (FDA decisions due within 3 weekdays as calendar items, outcomes from the last 3 days) are built; `congress:house` reads the House Clerk's yearly ZIP index and the e-filed PTR PDFs (`unpdf` 1.8.1; scanned paper filings are skipped), every 6 h, one tier-3 item per stock or option trade in a tracked ticker, never a trigger (`meta.congress` is context in the policy). Skipped (§4.3): `options_flow`, `fedwatch`, `nyse_halts`, `earnings_whispers`, Capitol Trades, `google_trends`, `truth_direct`.)*
- [x] 7.4 [both] Check each site's ToS and robots.txt first. Skip any site that forbids automated access, and note it in §4.3. *(Done 2026-10-26 from the server; the skipped sites and why are in §4.3. Owner calls on the grey ones: MarketBeat (terms: use the provided interface, no bulk redistribution), RTTNews (personal use) and the House Clerk files (5 U.S.C. §13107(c) restricts commercial use) approved; Google Trends declined. Open: NYSE's own history shows LULD pauses the Nasdaq halts history lacks, so check the live Nasdaq RSS for non-Nasdaq LULD pauses in session.)*

**Done when:** the sidecar runs on the server and the wave-3 sources are healthy or documented as skipped.

### Phase 8: Docs and tuning

- [x] 8.1 [both] `docs/ARCHITECTURE.md`: a news engine section (components, sources, data model, events, settings, research modes, failure behavior) and the seed runs. `README.md` and `.env.example`: the keys. *(Done 2026-10-26 in both: `docs/ARCHITECTURE.md` has a news engine section (components table, severity, policy and gates, research modes, settings, events, failure behavior; stocks also covers the price layers and scan universe) and a one-time seed section; the data model lists `wire_items`, `wire_triggers` and `seed_runs`. README covers the wire and the scraper; `.env.example` and the server guide cover `SCRAPER_URL` and the second container, and a container proxy must keep the engine on the `default` network.)*
- [ ] 8.2 [both] After 2–3 days live, review `wire_triggers`: label 30 fired triggers as right or wrong; tune the severity bases, thresholds and anomaly z; move noisy sources down a tier or disable them. Record the changes in the Progress log. Defaults change in code; live values change through Admin.
- [ ] 8.3 [both] Check Grok research spend per day against before the wire. If `auto` skips too little, tighten its skip rules.

### Phase 9: Later and optional

- [ ] Preempt a running scheduled cycle for critical held events (per-cycle `AbortController`).
- [ ] Reddit, once API access is approved.
- [ ] [S] A full-market stock breadth feed to replace layers B and C (§3.13): the Schwab Trader API (free with a Schwab brokerage account; OAuth with a rotating 7-day refresh token persisted in MongoDB), or Alpaca's paid SIP plan if the owner chooses to pay.
- [ ] Event-study backtests: forward returns by wire category, using `first_seen_at`, feeding the crypto `event_driven` screen and stock setups.
- [ ] Cross-bot sharing: macro and BTC items from the crypto wire visible to the stock bot.
- [ ] Stocks: extended-hours limit orders for earnings reactions; a `tighten_stop` that replaces the OCO stop leg.
- [ ] Budget-capped cheap-model triage of ambiguous items.

---

## 6. Going live

There is no shadow period: the defaults ship live (§8). After each phase deploys, check within the first hour and keep watching for the rest of the first day:
- Every source's health and lag in Admin.
- Items per hour per source (a flood means the relevance filter or lexicon needs tightening).
- Trigger rate against the caps (cap hits mean the thresholds are too low).
- AI spend against the budget and reserve.
- The event-cycle latency.

If something goes wrong, the owner sets `wire.mode` to `off` (or `shadow`) in Admin. Trading falls back to today's behavior at once.

---

## 7. Risks and how the plan handles them

| Risk | Handling |
| --- | --- |
| Fake or hacked-account news causes a buy | Confirmation gate for entries; Grok decides; risk engine; caps and cooldowns |
| Prompt injection through headlines or scraped pages | Sanitized, length-capped, `<untrusted>` fences; the decision model has no tools; the dashboard renders text only |
| Trigger storms on volatile days | Per-symbol cooldown, hourly and daily caps, minimum gap, queue merges by symbol, anomaly re-arm |
| Many sources = many breakages | Catalog-driven generic kinds; per-source isolation, health and auto-degrade; the wire fails open; `full` research fallback when unhealthy |
| Restart replays old news as new | `trigger_max_age_minutes` on `first_seen_at`; dedupe ids persist |
| AI budget drained by events | Caps; scheduled cycles can't touch the reserve; short event prompts and timeouts |
| Rate limits, ToS, IP blocks | Per-domain limiter, conditional GET, SEC User-Agent, robots.txt, auto-degrade on 403/429, ToS check before scraping |
| Atlas storage fills up | Relevance filter, 90-day TTL, Phase 0.7 sizing check |
| Seed buy runs twice or at a bad time | `seed_runs` refuses a second run without `force`; stocks run only in session; one attempt, no auto-retry |
| Memory or CPU on the server | Bounded buffers and indexes; headless browser in a separate container with capped concurrency and periodic restarts |

---

## 8. Decisions (owner, 2026-10-26)

1. **Kraken delisting:** unlikely for top coins. No automatic sale; normal review + alert. With real money the owner would sell on another exchange, which is out of scope for the paper wallet.
2. **Data:** free sources only, as many as possible. API keys are fine (the owner provides them). Avoid free tiers with tiny quotas. HTML and headless scraping are allowed.
3. **Dashboard:** public. No new page: the news engine goes on the existing **Research** page, with **AI research** and **our research** as separate sections.
4. **Rollout:** no safe or staged rollout. Ship live as soon as each phase works.
5. **Seed buys:** about $2,000 per bot, Tue 2026-10-27 morning (09:45 ET). *(Changed by the owner on 2026-10-26: $5,000 per bot; crypto at 09:45 ET, stocks scheduled for 09:30 ET and run after the 10-minute open buffer, about 09:40.)* One time only, never again unless requested. The allocation is decided by research that morning.
6. **Caps:** 4 event cycles per hour, 24 per day, and 30% of the AI budget reserved for events. Approved.
7. **Live page:** shows news engine data only when it is valid and applies (§3.12): a "News that matters" card, an "Our research" step in the cycle trail, a "Triggered by" banner, and notable items and real triggers in the Activity feed. No raw feed.
8. **Stock prices:** 30 live symbols is not enough. Use layered free feeds (§3.13): Alpaca minute bars for every symbol, the Yahoo streamer, Finnhub WS, and Alpaca snapshots as fallback. The broker stays ground truth for orders. Schwab, or a paid Alpaca data plan, is an optional upgrade later.

9. **Social lists (Phase 6.5, owner, 2026-10-26):** Telegram: crypto follows binance_announcements, WatcherGuru, whale_alert_io, wublockchainenglish and cointelegraph; stocks follow WalterBloomberg, FinancialJuice and marketfeed. Bluesky: crypto follows coindesk.com, decrypt.co, protos.com, web3isgoinggreat.com, molly.wiki, bloomberg.com, reuters.com, apnews.com, wsj.com, cnbc.com, axios.com and politico.com (crypto keywords only); stocks follow bloomberg.com, reuters.com, apnews.com, wsj.com, cnbc.com, nytimes.com, axios.com, politico.com, marketwatch.com, barrons.com, businessinsider.com, economist.com and semafor.com. All tier 3.

10. **Newsletters (Phase 6.5, owner, 2026-10-26):** crypto follows Glassnode Insights, Unchained, Bankless, The Defiant and Arthur Hayes; stocks follow the NY Fed's Liberty Street Economics, Employ America, Abnormal Returns, Noahpinion, The Overshoot, Apricitas Economics, Net Interest, Doomberg and Kyla Scanlon. RSS, tier 3, every 15 min (`newsletter:*` in the catalogs). Arthur Hayes, Noahpinion, Net Interest and Doomberg rarely pass the relevance filter (titles name no ticker or macro topic); review them in 8.2. No working feed: CoinShares fund flows, Galaxy Research, Kaiko; Week in Ethereum News and Crypto Is Macro Now didn't answer from the server.

Still open:
- Apply for Reddit API access now? This is optional, and approval reportedly takes weeks.

---

## 9. Progress log

| Date | Repo | Phase / tasks | Notes |
| --- | --- | --- | --- |
| 2026-10-26 | both | — | Plan written, then revised with the owner's decisions (§8). Nothing implemented. |
| 2026-10-26 | crypto | Phase 1: 1.1–1.3, 1.5–1.7 | Seed commands + `seed_runs`, `orchestrator/seed.ts` (full research → `seedAllocationSchema` → `processDecision` with `seed` sizing), `ownerDirected` in `evaluateCryptoEntry`, `CycleRequest`, Admin card, tests (89 engine + 26 core pass). Engine container deployed. |
| 2026-10-26 | stocks | Phase 1: 1.1, 1.2, 1.4–1.7 | Same commands/collection (mirrored `state/seed-runs.ts`), seed intraday cycle via `runCycle({ seed })`, `bot/seed.ts` rules, seed prompts, `trigger_kind` on decisions, Admin card, tests (436 engine + 63 core pass). Engine container deployed. Next: owner schedules both seeds (1.8), then Phase 0 / Phase 2. |
| 2026-10-26 | crypto | Phase 0 (crypto parts), Phase 2, Phase 3.1/3.3/3.4/3.6 | Wire core deployed live: 21 wave-1 sources healthy within a minute, ~200 items. As built: `retention_days` default 30 (Phase 0.7); tags, category and market-wide are read from the title first (summary only as fallback, amounts like "400 ETH" ignored); exploit base scales with the dollar amount (<$10M 40, <$100M 70, else 90); near-duplicate copies are not stored, they become confirmations on the cluster root; a source's first poll is stored as backfill and can never trigger; the `anomaly` source (`wire/sources/kraken-market.ts`) runs the mirrored `AnomalyDetector` on Kraken 1-minute bars (REST warm-up of 720 bars) and watches USDT/USDC for a depeg. Not yet: spread-blowout annotation (left for wave 2 with the Coinbase premium). Next: Phase 4 in crypto. |
| 2026-10-26 | crypto | Phase 4 (4.1, 4.2, 4.4, 4.6, 4.8–4.12) | The wire acts: `wire/dossier.ts` (mirrored) feeds a fenced `# WIRE` section into every decision prompt (`crypto-v4`); `wire/policy.ts` implements the §3.5 crypto rules and gates and writes `wire_triggers`; `Engine.requestEventCycle` queues by symbol and drains after each cycle (event cycles skip `min_ai_interval` but respect `event_min_gap_seconds`); event cycles use only focus candidates (`event_driven`) and forced reviews, `x_verify` gap-fill research (`research_gap` task) and the event timeouts; scheduled cycles pick full / gap-fill / skipped research per `research_mode` with the 30% reserve; dossier URLs are allowed citations and cited items become notable; `emergency_action` (review / tighten_stop / exit) and `wire.replay`. As built: `macro_reaction` uses the market-shock threshold (`anomaly.market_z`), not a separate z ≥ 3; regulatory_shock also covers Truth Social posts. Tests: 129 engine tests pass. Deployed. Next: Phase 5 (dashboard) in crypto. |
| 2026-10-26 | crypto | Phase 5 (5.1–5.10) | Research page has "AI research" and "Our research" tabs (live item list with symbol/category/source/severity filters, triggers with reasons, source-health strip); research detail shows the research mode, a skip reason, the dossier the AI saw and a "Triggered by" card; Live page has the "News that matters" card (notable items only, why-chips, move since), an "Our research" step and a "Triggered by" banner in the cycle trail, event/seed badges; the activity feed shows only notable items and acted-on triggers ("News" filter); Admin shows per-source health and a "News engine" settings group; decision pages show "Triggered by"; Analytics has a news-engine section (funnel, latency, outcomes by trigger kind and category, spend by task). Shared UI in `apps/web/components/wire.tsx`. `next build` passes. The crypto engine now also fails cycles left running by a restart. Dashboard deploys on the owner's next push. Next: port Phases 1–5 to stocks (Phase 1 already done there). |
| 2026-10-26 | stocks | Phase 0 (stock parts except 0.6, 0.9), Phase 2, Phase 3 (3.2, 3.3, 3.6; 3.5 layer B only), Phase 4 | The mirrored wire core copied over unchanged (`@smb/core`); stock catalog with 31 wave-1 sources, all healthy in the heartbeat (see the Verified list under §4.2); `sources/edgar.ts`, `halts.ts`, `alpaca.ts` (news REST + movers) and `stock-market.ts` (all-symbol IEX minute bars → mirrored `AnomalyDetector`, SPY as reference, market shocks from SPY's 5-minute move). Phase 4: stock rules in `wire/policy.ts` on the mirrored `wire/trigger.ts` gates (session-aware: off-hours triggers are suppressed, held-negative and halt items alert); `Engine.requestEventCycle` with the event window (regular session, past the opening buffer, more than 3 min before the close); event intraday cycles with `buildContext(…, { scope: "event" })`, gap-fill research and the event timeouts; `researchPlan` for scheduled cycles (the seed always gets full research); the dossier replaces `context.news`; `PROMPT_VERSION` `2026-10-27.wire-1`; `emergency_action` exit; `wire.replay`. As built: halts older than 2 days are dropped (the feed lists years-old halts); event triggers expire after 30 min in the queue. Tests: 455 engine and 63 core tests pass. Engine deployed. Next: Phase 5 in stocks, then 3.5 (the remaining price layers). |
| 2026-10-26 | stocks | Phase 0.9, Phase 3.5, Phase 5 (5.1–5.10) | **Price layers (3.5):** scan universe of 1,500 symbols built at boot in 45 s (SIP daily dollar volume ≥ $20M, price ≥ $5); `PriceBoard` merges A–E into 1-minute bars for ~1,500 tracked symbols; Yahoo streamer (1,502 subscribed), Finnhub WS (≤ 50: focus, watchlist, held) and the snapshot fallback; each layer is a wire source with a `detail` status line (new optional `WireSourceHealth.detail` in core, both repos). The mirrored `AnomalyDetector` keeps its time map only for the reference (about half a track's memory), skips NaN volumes and gained `forget()`; warm-up is paced and live bars wait for it. **Dashboard (5):** same features as crypto, adapted (see the 5.5 note; outcomes by trigger kind use entries, win rate and net P&L because stock decisions have no right/wrong score; trigger links go to the report). Shared UI in `apps/web/components/wire.tsx`. Tests: 462 engine tests pass (crypto 130 after the mirrored detector change); web typecheck, lint and `next build` pass. Engine deployed; dashboard deploys on the owner's next push. Next: at the open, confirm layer B bars and the Yahoo rate; then Phase 6 (wave 2) in crypto. |
| 2026-10-26 | crypto (+ both for 6.1, 6.4, 6.5) | Phase 6: 6.1, 6.2, 6.4, 6.5 (lists), 6.6 [C] | Wave 2 live in crypto: about 40 new sources (10 more outlets, 5 client-release feeds, Kraken blog, ECB/BoE/BoJ, Binance announcements and 4 more Telegram channels, Bluesky with 12 accounts, Federal Register, Solana status, Coinbase products, GDELT, CFTC COT, Kraken Futures, Hyperliquid, Deribit, Coinalyze, DefiLlama, Polymarket, Kalshi, mempool, Etherscan, ApeWisdom, StockTwits, CoinGecko, App Store, Wikipedia, Fear & Greed, BLS/FRED actuals at release, Coinbase premium). New setting `wire.coinbase_premium_pct` (0.3). Mirrored changes: `metrics.ts`, `sources/bluesky.ts`, `SourceContext.settings()`, `SourceSpec.refine`, `fetch.postJson`, limiter rates, our own metric items no longer "explain" a price move, and a category found only in an item's summary gets half weight. Exploit items without a dollar amount now start at 60 (security research and fixes at 30) instead of 85. Stock catalog: Telegram (3 channels) and Bluesky (13 accounts) live. Tests: crypto 169, stocks 464. Both engines deployed. Next: stock 6.3 (in progress). |
| 2026-10-26 | stocks | Phase 6: 6.3, 6.6 [S] | Wave 2 live in stocks: about 50 new sources. Outlets: CNBC, MarketWatch, WSJ Markets, Fox Business, NYT Business, FT, Politico, the Economist (tier 2); Investing.com, RTTNews, Benzinga (tier 3, evergreen posts dropped); Seeking Alpha, Nasdaq per-symbol RSS and the Finviz news page. ECB/BoE/BoJ decisions, Federal Register (tariff and entity-list searches, trade-remedy case notices dropped), BLS/FRED actuals, EIA crude and gas weeks, VIX and 2y/10y yields, weak Treasury auctions, Kalshi and Polymarket odds, CNN Fear & Greed, StockTwits trending, ApeWisdom and Tradestie, App Store ranks, Wikipedia views, openFDA approvals, FDA advisory committees, ClinicalTrials.gov halts, Nasdaq earnings/dividend/IPO calendars, OpenInsider and Finviz insider trades, USAspending contracts ($100M+), CFTC COT and FINRA short volume. Items naming any listed company (FDA approvals, contracts, insider clusters) are low volume and dated by the event, so the 2-hour old-news gate keeps them in the dossier. No mirrored file changed. Probe: 39 of 495 outlet headlines (8%) passed relevance with 20 tracked symbols. Tests: stocks 495. Stock engine deployed. Next: Phase 7 (headless scraper sidecar). |
| 2026-10-26 | both | Phase 7 (7.1–7.4), 6.5 newsletters, 8.1 docs | Scraper sidecar built and running in both compose projects (no host port; ~140 MB idle); the engines get `SCRAPER_URL` at their next deploy. Phase 7.4 terms check from the server: 8 sites forbid bots, 2 sit behind Cloudflare challenges, Upbit's pages disallow crawling (§4.3); the owner approved MarketBeat, RTTNews and the House Clerk files and declined Google Trends. Built: crypto `korea:upbit`, `korea:bithumb`, `korea:bithumb_alerts`, `hacks:slowmist`; stocks `ratings:marketbeat`, `earnings:marketbeat`, `pdufa:rttnews`, `congress:house`. None needs the sidecar. Newsletters (§8.10): 5 crypto, 9 stocks. New limiter rate for Bithumb (1 request/s per IP). Docs: news engine and seed sections in both ARCHITECTURE.md files. Tests: crypto 177, stocks 519. Engines not redeployed tonight so nothing changes before the seeds; deploy both after the seeds have run on 2026-10-27. |
