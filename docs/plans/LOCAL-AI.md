# Plan: a local AI agent for both bots

Status: **decisions taken on 2026-10-27**: every recommendation in §15, and no Grok at all once the agent takes over (decision 1). Step 0 of §14, the measurement spike, is running. Step 1 (the history store and the news archive) was built beside it on 2026-10-27, since it doesn't depend on the model: `@mb/history`, the `history` and `history-backup` services ([SERVER.md §3.6, §6.4](../SERVER.md#64-the-history-stores-volume-and-backups)). Nothing that trades has changed.

Both bots, crypto first. Paper trading only, as always.

## 1. Goal

Replace Grok with models that run on the server's two GPUs, and change how the bots think:

- **Event-driven, not timed.** The model wakes within seconds of something that matters (news, a price shock, a fill, a level it asked to watch) instead of every 15 or 30 minutes.
- **Years of data.** Price history, news history and the bots' own decisions and outcomes, reachable by the model while it decides.
- **Agent-like.** In each wake-up the model looks things up with tools, decides, and leaves itself watches and notes for later.
- **Bounded.** The model proposes; code disposes. Its authority grows only as it proves itself, and shrinks automatically when it misbehaves.

Not in scope: live trading, shorting, margin, leverage, options beyond the stock bot's defined-risk set, and models that rewrite their own rules or prompts.

## 2. Where things stand

**The AI today** ([CRYPTO.md](../CRYPTO.md#ai-workflow), [STOCK.md](../STOCK.md#one-cycle)):

| | Crypto | Stock |
| --- | --- | --- |
| When the AI runs | a scan every 15 min (at most every 10), price-move reviews, news event cycles (≤ 4 an hour, 24 a day) | the session phases and 30-minute intraday cycles, price-move cycles, news event cycles (same caps), the weekly core review |
| Per cycle | Grok research with web + X search, then a Grok structured decision | same |
| Authority | normalization, then the deterministic risk engine | normalization, then the rule-by-rule checks |
| Budget | $5/day default | $10/day default (a full trading day cost about $3.80) |
| Local model | `llama3.2:3b` on Ollama (RTX 3070) writes article summaries for both bots, nothing else | |

Most of the limits on when the AI runs exist because every call costs money.

**The data the bots keep:**

| | Crypto | Stock |
| --- | --- | --- |
| Prices | none stored; Kraken's 720 candles per interval on demand (30 days of 1h, ~2 years of daily) | ~3 months of daily bars in a cycle's context; a year of SIP daily bars for the core ranking |
| News | `wire_items`, 30-day TTL | same |
| Own history | cycles, research, decisions with scored outcomes: permanent | cycles, reports (with the full context Grok saw), decisions: permanent |

The 30-day TTL deletes a day of news every day. That is the one thing in this plan that can't be recovered later, which is why archiving it is step 1.

**The server** (measured 2026-10-27):

| | |
| --- | --- |
| GPU 0 | RTX 3070, 8 GB, Ampere (compute 8.6), PCIe x16. Drives the Windows display (~0.6 GB in use), shared with Jellyfin's transcoding, runs `marketbots-llm` |
| GPU 1 | RTX 2080 SUPER, 8 GB, Turing (compute 7.5), **PCIe 3.0 x4 link**: the ASUS PRIME B560-PLUS's second x16 slot is wired x4 from the chipset (B560 can't split the CPU's lanes across two slots). Headless and idle |
| CPU | i5-11400, 6 cores / 12 threads |
| RAM | 24 GB today (one 8 GB stick at 2667 and two at 2133, so all run at 2133); **32 GB by the time this runs**. Without a `.wslconfig`, the Docker VM gets half the host's RAM: 11.6 GiB today, about 15.5 GiB at 32 GB. The other stacks use ~4.6 GiB of it |
| Disk | C: 464 GB (275 free), Z: 7.4 TB (2.9 TB free) |

What that means:

- **16 GB of VRAM, but as two separate 8 GB pools.** The x4 link rules out tensor parallelism; splitting a model by layers across both cards works (little traffic per token).
- **Turing has no bf16 and no FlashAttention 2**, which the fastest server stacks (vLLM) lean on. llama.cpp runs quantized (GGUF) models well on both cards, with its own attention kernels, so it is the inference engine here.
- **An 8 GB card holds a ~7–9B model at 4-bit with a 16–32k context**, or a ~3–4B model with room to spare. A ~14–24B model needs both cards.
- **Mixture-of-experts (MoE) models change the picture.** A ~20–35B MoE model uses only 3–4B of its parameters for each token, so split across both cards it runs about as fast as a small model (§5).
- **RAM is covered at 32 GB.** The new services need ~4–5 GB beyond today's, which wouldn't fit in today's 11.6 GiB VM but fits in ~15.5 GiB with room to spare (§15, decision 3).
- **Power**: the two cards can draw 470 W together. Check the PSU's rating before both run flat out. A power limit on the 2080 SUPER costs little speed, since generating text is bound by memory bandwidth, not compute.

## 3. Principles

1. **Code keeps the authority.** The model never talks to Kraken or Alpaca, never holds keys and never changes settings. Its final answer is today's decision schema, which goes through today's normalization, risk engine and execution, unchanged.
2. **Real time means event-driven.** Code watches every tick and every item (milliseconds); the model wakes on what matters and answers in seconds. Nothing waits for a timer, apart from a slow safety sweep.
3. **Years of data reach the model through tools, not its context window.** A year of one-minute bars for one pair is ~525,000 rows; a local model's working context is 16–32k tokens. The model asks questions ("what happened after the last ten 10% drops?") and code answers them from the history store. Numbers come from statistical models that can be backtested; the language model reads the news and weighs things up.
4. **Free thinking, rationed acting.** Local inference makes a wake-up cost close to nothing, so the limits move from AI calls to actions: entries per day, money committed per hour, per-symbol cooldowns.
5. **Earn authority.** Shadow beside Grok, then propose with the owner approving, then act alone inside a small envelope. Promotion is the owner's decision on measured results; demotion is automatic.
6. **Two independent agents.** One shared runtime package, but each bot has its own tools, prompts, data, settings and model slot. No runtime link between the bots: the model server is shared the way the scraper is.

## 4. Architecture

```
  prices · features · screens · the wire · fills · stops · sessions · calendar · watches firing
                                         │  code, milliseconds
                                         ▼
                 observations: typed, scored for salience, coalesced per subject, prioritized
                                         │
                                         ▼
       episode (local LLM, seconds): brief → step → step → … → answer
                │                                                  │
                ▼                                                  ├─▶ watches: checked by code on every tick
      read-only tools: history store, event studies, news          └─▶ notes: shown in the next brief
      analogs, quant forecasts, dossier, book and headroom,
      past decisions, articles, option menus, depth                │ decisions in today's schema
                                                                   ▼
                    normalize → agent envelope → risk engine → execution → paper broker
                    (today's)       (new)         (unchanged)   (unchanged)
```

On the server:

```
marketbots stack
  crypto-engine, stock-engine ──▶ llm         llama.cpp across both GPUs: one MoE model, always loaded;
                               │               a slot per bot and one for reading news (replaces Ollama)
                               ├─▶ history     Postgres + TimescaleDB + pgvector: crypto_history, stock_history
                               ├─▶ quant       Python: forecasts and embeddings (CPU); training at night
                               └─▶ scraper     as today
  network `ai` (internal, no internet): llm, history, quant, and the engines
```

## 5. GPUs and inference (`llm`)

**Layout**: one mixture-of-experts (MoE) model, split by layers across both cards, replacing today's Ollama container.

An MoE model has many parameters but uses only a few billion for each token, so a ~20–35B MoE model reasons more like a large model and generates about as fast as a small one. A layer split sends little between the cards, so the x4 link doesn't slow it. Model quality is the biggest risk in this plan (§17), so the best model that fits is worth more than keeping the work on separate cards.

- **The split**: most layers on the 2080 SUPER (headless, ~7.8 GB free), the rest on the 3070, leaving ~1 GB there for the display and a Jellyfin transcode. Plugging the monitor into the motherboard (the i5-11400's own graphics) would free the 3070's ~0.6 GB too. Those graphics are off today (Windows lists only the two NVIDIA cards); turning them on is a BIOS setting.
- **Slots**: three, one per bot and one for reading news (§6.3) and article summaries. The news slot runs at the lowest priority, so it never holds up an episode.
- **Embeddings**: a small embedding model on the CPU, in `quant` (§7).
- **Loaded**: always (a cold load took 134 s on this server).

**Candidates**, in the order step 0 tries them. The names and sizes come from 2026 reports; check each model card before downloading.

| Model | Size at 4-bit | Fit | For it |
| --- | --- | --- | --- |
| gpt-oss-20b (OpenAI; 21B, ~3.6B active) | ~12–13 GB | both cards, with ~1.5 GB left for context and buffers | fits with margin; built for tool calls and structured output; its reasoning effort is adjustable (low for P0, higher for reviews) |
| Gemma 4 26B-A4B (Google; ~4B active) | ~15 GB | both cards, with the monitor moved off the 3070 or a few experts in system RAM | newer, likely stronger |
| Qwen 3.6 35B-A3B (Alibaba; ~3B active) | ~20 GB | both cards plus ~7 GB of experts in system RAM (llama.cpp's `--n-cpu-moe`), with the Docker VM raised to ~22 GB | likely the strongest; slower, most of all on long prompts |
| A ~9B dense model (e.g. Qwen 3.5 9B) | ~5–7 GB | one card | the fallback: the agent alone on the 2080 SUPER and news reading on the 3070, if the split can't stay on the GPUs beside Jellyfin |

The eval set (§10) chooses among them, on our own recorded cycles rather than public benchmarks.

**Serving: llama.cpp's `llama-server`**, the image pinned by digest, the models pinned by SHA-256 in a `models` volume:

- one container with both GPUs, pinned by UUID (the device order can differ between Windows and WSL), split by layer and weighted toward the 2080 SUPER;
- `--parallel 3`: a slot per bot and one for news, so a crypto episode never blocks a stock exit review;
- prompt caching per slot: each step of an episode re-sends the same brief, and only the new part is processed;
- JSON-schema output (llama.cpp turns the schema into a grammar), so every step's answer is valid JSON by construction. The decision schemas already avoid the keywords providers disagree on (`crypto-core/src/report.ts`);
- an OpenAI-compatible API, so `AiRunner` gains a local provider (`@ai-sdk/openai-compatible`) and model ids like `local/<name>`. `ai_calls` records local calls with tokens, GPU time and a cost of 0;
- no internet: the server sits only on the internal `ai` network. Models are downloaded on the host and checked against their hash.

The GPU guard the summaries already use applies to the whole server: the model must sit where its configuration puts it (wholly on the GPUs, unless the configuration places some experts in RAM), or the work pauses rather than crawling on the CPU. On Windows the NVIDIA driver can also spill CUDA memory into system RAM without telling anyone, so step 0 sets *CUDA – Sysmem Fallback Policy* to *Prefer No Sysmem Fallback*. The engines check the loaded model's hash against settings at boot and before each episode; a mismatch stops episodes.

**Rough capacity** (to be measured in step 0): an MoE model with ~3–4B active parameters, split across these cards, should generate 40–80 tokens/s per stream and read 1,000–2,500 tokens/s (less for the Qwen option, with experts in RAM). A typical episode (a 3k-token brief, five tool results, a 1k-token answer) then takes 20–45 s, which leaves room for well over 100 episodes an hour per bot. Today's bots run a handful of AI cycles an hour.

## 6. The history store (`history`)

### 6.1 The database

One Postgres container with TimescaleDB (time series) and pgvector (similarity search), no host port, memory cap 2 GB.

- **A database per bot**, `crypto_history` and `stock_history`, each with its own role. Each engine gets only its own credentials, which keeps the bots apart at runtime as the import rules do in code.
- **A Docker named volume** (on C:, inside the WSL disk), not a Windows bind mount: Postgres on a bind-mounted Windows drive is slow and unsafe.
- **A nightly backup of only what can't be fetched again**: the archived news and triggers. It goes to `backups\history\` in the repo folder, next to the wallet's backups (git-ignored, outside Docker, so it survives a Docker or WSL reset); the newest 7 are kept. Bars, series and embeddings aren't backed up: the backfills rebuild them.
- **Atlas stays the dashboards' database.** Vercel can't reach the server's Postgres, so whatever a page needs from history, the engine copies into Atlas, as the stock bot's `cache` already does for chart bars.

### 6.2 What goes in

| Data | Crypto | Stock | How |
| --- | --- | --- | --- |
| 1-minute bars | every universe pair, all of Kraken's history | the top ~300 by dollar volume, the benchmarks and holdings, from 2016 | crypto: Kraken's downloadable OHLCVT files (the backtester already reads them), and the gap since the last file from Kraken's trades endpoint; stock: Alpaca's SIP history. Then each engine appends the closed 1-minute bars it already builds |
| Daily bars | every universe pair | the scan universe (~1,500), from 2016 | same |
| Market series | funding, open interest, DVOL, Coinbase premium, TVL, odds | VIX, yields, short volume, odds, EIA, COT | the wire's `MetricWatcher` feeds as they arrive, backfilled where the source has history |
| News | every wire item and trigger, archived before the TTL deletes it, with its embedding, the price when first seen and the moves 1 h, 1 d and 5 d later | same, plus EDGAR 8-K filings from 2016 | a nightly archive job, then a live append; GDELT's file dumps for older news (not its API, which rate-limits us) |
| Own history | decisions, outcomes, episodes (§8.6) | same, plus reports and core reviews | copied nightly from Atlas |

Size: ~400 million 1-minute rows compress to a few GB in TimescaleDB; a million news items with embeddings add 1–2 GB. Well under 50 GB.

Backfills are resumable jobs with their progress in the heartbeat. The stock backfill shares the engine's Alpaca key, so it runs inside the stock engine within a fixed share of the REST rate limit, never as a second process with the live key ([AGENTS.md](../../AGENTS.md), ground rule 2). Daily bars take under an hour; minute bars take a few days.

### 6.3 Reading every item (perception)

Today the AI only sees the items that make it into a paid cycle. Locally, the model can read every item the wire keeps, in its news slot at the lowest priority: who and what it is about, which direction, and whether it is **new information or a rehash** of something already seen (the wire sees 60–180 single-source headlines a day). Its read becomes one more part of the item's severity, bounded at ±15 points and kept in the audit trail like the other parts. The embedding goes into the history store for analogs (§7).

## 7. The quant layer (`quant`)

The language model is good at reading and weighing, and bad at numbers over long histories. It also can't be backtested: it has probably read what happened next. So the years of price data feed models that *can* be tested:

- **Event studies** (SQL in the engines, no new service): "after BTC fell 8% in a day, what happened over the next 1, 3 and 7 days?" The count, median, quartiles and hit rate, with the same numbers for random days as the baseline.
- **News analogs** (pgvector): the past items most like this one, and how the price moved after each.
- **Setup forecasts** (`apps/quant`, Python): for each screen's setup, the probability that the target is hit before the stop within the horizon. That is the question the AI answers today as `p_target_first`. Gradient-boosted trees on the features both bots already compute plus the history store's series, labeled with each setup's own stop, target and horizon, trained walk-forward with a gap between the training and test periods, then calibrated. A model is used only if it beats the random-walk prior `stop / (stop + target)` out of sample; its Brier score and test period travel with every forecast.

Training runs nightly or weekly in the quiet hours, on the CPU (the GPUs hold the model). The quant service has no internet and no Atlas access: it reads the history store, answers `/forecast`, and computes the news embeddings with a small model.

Forecasts go first into the brief and the decision record (display only). If they prove better calibrated than the AI's probability over a few weeks, they replace the AI's shrunk probability in the edge gate (§14, step 12, a behavior change for the owner to approve).

## 8. The agent

### 8.1 Observations and the attention queue

Everything that might deserve a decision becomes an **observation**: a typed record with a subject (a symbol, the market or the book), a kind, a salience from 0 to 100 computed in code, references (wire item ids, order ids, the watch) and an expiry.

| Source | Becomes an observation when | Salience from |
| --- | --- | --- |
| The wire | the policy produces a trigger (today's `wire/policy.ts`) | the item's severity |
| Screens | a setup passes today's pre-AI filters (reward:risk, edge, not ruled on recently) | the setup and its quant forecast |
| Price | a shock (`wire/anomaly.ts`), a holding near its stop or through its invalidation | z-score, distance |
| The book | a fill, a stop hit, a rejected order, a holding's horizon elapsed | fixed per kind |
| Calendar | 15 min before a release that matters (FOMC, CPI, a holding's earnings) | fixed per kind |
| Sessions (stock) | premarket, the open (after the buffer), the closing window | fixed |
| Watches | a condition the agent set fires (§8.5) | the watch's priority |
| Sweep | every 2 h (crypto) or each session phase (stock): the safety net for what nothing triggered | low |
| Owner | *Ask the agent* in Admin | high, and read-only |

The queue turns observations into wake-ups:

- **Coalesce** per subject: wait 2–10 s (by priority) for the rest of a burst, 20 s at most, so twelve headlines about one hack become one wake-up.
- **Priority**: P0 risk to a holding > P1 an opportunity > P2 a review > P3 background.
- **A per-subject cooldown on waking** (5 min), broken only when salience rises 15 points or more, or by a P0.
- **Preemption**: a P0 for a bot aborts that bot's running P1–P3 episode between steps; the aborted episode is recorded.

The wire's trigger gates stay (fresh, confirmed, cooldown). Their hourly and daily caps, which exist for the AI's cost, give way to the action limits in §9.

### 8.2 Episodes

An episode is one wake-up:

1. **Brief** (code, 2–4k tokens): the observations (outside text fenced as untrusted, as today); the book and its **risk headroom**, meaning what the risk engine would allow right now (the largest new position, entries left today, and why entries are blocked if they are); the subject's features and quant forecast; its notes and watches; the last decisions on it and their outcomes; the market read.
2. **Steps** (the model): each step is the model's thinking (free text, §8.8), then one JSON object, constrained by a grammar to be either a tool call with a short `purpose` (≤ 25 words, the step's label on the dashboard) or the final answer. Grammar-constrained steps are more reliable with small models than free-form tool calling.
3. **Limits** by priority:

| Priority | Examples | Coalesce | Steps | Thinking | Time |
| --- | --- | --- | --- | --- | --- |
| P0 risk | bad news on a holding, a price through an invalidation, a holding's watch | 2 s | 4 | low | 20 s |
| P1 opportunity | a screen setup, entry-grade news, an entry watch | 5 s | 8 | medium | 60 s |
| P2 review | session phases, the sweep, the owner's question | 10 s | 10 | high | 120 s |
| P3 background | upkeep of notes, the weekly core review (stock) | — | 20 | high | 10 min |

Thinking is set through the model's own effort switch where it has one (gpt-oss's low / medium / high; Qwen's thinking on or off). The time limit is the hard stop.

An episode that runs out of steps or time ends with no action, and a P0 one also alerts. An answer that fails the schema is retried once at a lower temperature; after that it is a no-action, as today.

### 8.3 Tools

All read-only and typed (zod arguments), with capped output (a few hundred tokens each), and every call is recorded.

| Tool | Returns |
| --- | --- |
| `book()` | positions, cash, exposure, risk headroom, the envelope's remaining room (§9) |
| `quote(symbol)`, `features(symbol, interval)` | the live price and the features code already computes, never raw bar dumps |
| `bars_summary(symbol, interval, lookback)` | a compact description of a period: return, range, trend, volatility, notable days |
| `event_study(subject, condition, horizons)` | §7: forward returns after past occurrences, against the baseline |
| `analogs(item_id)` | §7: similar past news and the price moves after it |
| `forecast(symbol, setup)` | §7: the calibrated probability and its test record |
| `news(subject, since)`, `dossier(subjects)` | the wire's items and today's dossier |
| `read_article(url)` | the scraper's extract; only URLs that appeared in this episode's brief or tool results |
| `past_decisions(symbol)` | the bot's own decisions on it, with outcomes |
| `calendar(days)` | scheduled releases and earnings |
| Stock: `option_menu(symbol)`, `core_book()` | today's menus (the agent can only pick from them); the core holdings and their theses |
| Crypto: `derivatives(symbol)`, `depth(symbol)` | funding, open interest, basis; the order book's depth and spread |

No tool runs code, writes settings, changes the universe or touches orders.

### 8.4 The answer

The final step returns the bot's **existing decision schema** (crypto's `cryptoDecisionSchema` items; stock's `decisionSchema` items and option orders), plus:

- `watches`: conditions to wake on (§8.5);
- `notes`: what to remember about a subject;
- `evidence_refs`: the item ids and tool calls each claim rests on.

Code normalizes it with today's functions (only listed or held symbols, actions that fit the position, numbers clamped, only sources that were actually retrieved), applies the envelope (§9), then hands it to today's risk checks and execution: `evaluateCryptoEntry`, `evaluateExit` and the executor for crypto; `executeDecisions` for stock. Those don't change.

### 8.5 Watches and notes

A **watch** is how the agent acts in real time without polling: "wake me if SOL/USD closes an hour above 182", "if funding goes over 80% annualized", "if anything at review severity names NVDA", "at 13:45 ET". Code checks watches on every tick or item (the crypto hub's book, the stock price board, the wire), so a watch fires within milliseconds and its episode starts seconds later.

- Kinds: price above or below, a move of x% within a window, a closed-bar condition on a feature, a threshold on a market series, news on a subject at a severity, a time.
- Each has a note (≤ 300 characters, shown in the brief when it fires), a priority and an expiry (≤ 7 days); at most 5 per symbol and 40 per bot.
- A watch only wakes the agent. It never places an order itself: an order placed by code at trigger time, without a fresh look, is exactly what the AI's pass is meant to prevent (conditional orders are in §18).

**Notes** are the agent's working memory per subject: at most 5 per subject, 500 characters each, expiring after 14 days, shown in every brief on that subject and on the dashboard. The agent can't edit its prompt, its tools, its envelope or the settings; the current design's "no automatic learning" rule stays.

### 8.6 The journal

Every episode is recorded in full: the observations, the brief, each step (purpose, tool, arguments, result), the answer, what normalization, the envelope and the risk engine did to it, the timings, the model hash and the prompt version.

- Full episodes go to the history store. At ~100 episodes an hour per bot, ~50 MB a day, they are too many for Atlas.
- Atlas gets a compact `agent_episodes` summary (30-day TTL), plus the full trail of every episode that led to an order (permanent), so the dashboard can show it.
- Steps stream live as `seq: 0` events.
- A recorded episode can be re-run against another model or prompt version (§10), which is how changes are compared.

### 8.7 Per bot

- **Crypto**: 24/7. Today's screens become P1 observations. The 3-second protection loop and the stops are untouched. Entries only while the venue is online and the books are reconciled (the risk engine, as today).
- **Stock**: entries only in the regular session, as today; outside it, episodes can only set watches, write notes and alert. Option entries only from the menus. The weekly core review becomes a P3 episode with a long time limit and the history tools in place of web search; its rules (`core-book/rules.ts`) stay. Bad news on a core holding stays a single-holding review, now a P0 episode.

### 8.8 Seeing the thinking

Grok sends at most a summary of its reasoning. A local model's thinking is plain text it writes before each answer, and llama.cpp returns it separately from the answer, so all of it can be shown. This replaces the current design's "never hidden model reasoning" line for the agent; step 13's doc update records it.

- **Live**: each step's thinking streams to the Live page as it is written (`agent.thinking`, `seq: 0`), under the step's purpose and tool call. It is owner-only by default, because it is long and quotes untrusted news text; a setting can make it public. Like all model output, it is sanitized and rendered as text.
- **Kept**: with every episode in the history store for 30 days, for replays and debugging. In Atlas, permanently, for every episode that placed or proposed an order, so the dashboard can always show why it traded.
- **Never relied on**: code never reads the thinking to decide anything. The decision is the structured answer, its evidence and the risk checks, as today. The thinking is the model's own account and can leave things out or rationalize, so it is for understanding and debugging, not proof.
- **It costs time**: at 40–80 tokens/s, 1,000 tokens of thinking takes 15–25 s, which is why the amount follows the priority (§8.2).
- **Step 0 checks** that the grammar forcing valid JSON applies only to the answer, after the thinking. Otherwise the model would be made to answer without thinking.

## 9. Boundaries

Six rings, outermost first. Rings 1, 2 and 5 exist today and don't change; rings 3, 4 and 6 are new or extended.

**1. Impossible by construction.** There is no live-trading code path. The model server has no internet and holds no keys; the model only produces text, and only engine code acts. The tools are an allowlist with no write tools. The agent can't place orders except through §8.4, change settings, risk limits, the universe, prompts or its own envelope, run code, short, use margin, or trade outside the universe.

**2. The risk engine** (unchanged): every gate and cap, the kill switch, the drawdown halt, stops that only move up, exits allowed while paused or halted, the minimum hold for AI exits.

**3. The agent envelope** (new, tighter than the bot's own caps, set in Admin):

| Limit | Crypto | Stock |
| --- | --- | --- |
| New entries per day / per hour | 4 / 2 | 4 / 2 |
| Money committed to new entries per hour | 10% of equity | 10% of equity |
| Size of an agent entry | ≤ 50% of what the risk engine allows | same |
| Open agent positions | 4 | 4 |
| Actions per symbol | one per 30 min (tightening a stop is exempt) | same |
| After a stop-out | no re-entry in that symbol for 24 h | same |
| Flips | exiting and re-entering a symbol within 6 h is refused | same |
| Options premium per day | — | 1% of equity |

Risk-reducing actions (close, reduce, tighten a stop) are never blocked by the envelope's rate limits, only by the minimum hold.

**4. Circuit breakers.** These are automatic: the agent drops to shadow, and the owner gets a Discord alert and a dashboard notice. It goes back up only when the owner moves it up in Admin.

- 5 risk rejections in a row, or more than half of its proposals rejected in an hour;
- more than 10% of answers invalid in an hour;
- the envelope's flip or rate limits hit 3 times in a day (it keeps trying what it isn't allowed to do);
- the agent's book down more than 3% of equity in a day, or 6% since its last promotion;
- the loaded model's hash differs from the one in settings.

Slower failures pause entries without demoting: an inference p95 latency over the limit, a model not wholly on the GPU, the history store down.

**5. The owner**: the autonomy level (§10), the approval queue, the *Agent off* switch, the kill switch, and a Discord message for every agent order.

**6. What goes in.** Everything from outside (headlines, articles, search results) reaches the model only as fenced, untrusted text, with fence-breaking sequences neutralized, as today. Every claim must point at an item or a tool result from this episode, or it is downgraded to speculation (today's rule for URLs). `read_article` only opens URLs that appeared in the episode, so injected text can't make it fetch an attacker's URL.

## 10. Autonomy levels and promotion

| Level | What the agent does | Who trades |
| --- | --- | --- |
| 0 off | nothing | Grok, as today |
| 1 shadow | wakes, decides and records. Its decisions go into a **shadow book** (simulated fills at the live bid/ask with the paper wallet's slippage and fees) and are scored like any decision | Grok, as today |
| 2 propose | risk-reducing actions execute; entries wait in an approval queue (dashboard and Discord), expire after 10 min, and are re-checked by the risk engine at the price when approved | the agent, with the owner approving entries; Grok's cycles are off |
| 3 auto | everything, inside the envelope | the agent |
| 4 full | the same, with the envelope equal to the bot's own caps | the agent |

**Measured before anything is built on it** (§14, steps 0 and 4):

- **The eval set**: a few hundred recorded cycles per bot. The stock reports keep the full context Grok saw; crypto's are rebuilt from the features and dossier stored with each cycle. Each candidate model answers them, and we measure valid answers, latency and agreement with Grok. This picks the model and the GPU layout. It says nothing about edge, because the model may have read what happened next.
- **Dual decision**: for a few weeks, every live Grok decision is also put to the local model, once with Grok's research memo and once with the dossier only. Both are scored by the existing outcome scoring. This shows how close the local model gets on today's pipeline, and what the wire and the tools will have to make up for once Grok's web and X search are gone.

**Promotion** is the owner's call, per bot, on the Analytics page's numbers:

| From → to | Needs |
| --- | --- |
| 1 → 2 | ≥ 3 weeks in shadow; ≥ 30 scored entry decisions; < 2% invalid answers; no breaker trips in the last week; P0 latency p95 under 20 s; the shadow book, after costs, at least level with Grok's book and with holding BTC (crypto) or SPY (stock) over the same weeks |
| 2 → 3 | ≥ 2 weeks at level 2; the owner approved most proposed entries; no breaker trips |
| 3 → 4 | a separate decision after ≥ 3 months at level 3 (§15) |

These are guardrails against obvious failure, not proof of an edge: a few weeks of trades is a small sample. The forward record keeps growing either way.

## 11. Dashboard and Admin

No new tab: the agent fits the five-section navigation ([ARCHITECTURE.md](../ARCHITECTURE.md#the-dashboards-navigation)), and each piece of it has one page.

- **Live** (`/`): the episode as it runs takes the latest cycle's place (why it woke, each step's thinking, each tool call's purpose and result, the answer, what the envelope and the risk engine did). Beside it: the queue, the watches, the notes, today's use of the envelope, the level and the breakers, and the GPU (model, resident or not, tokens/s, queue).
- **Research → AI research**: past episodes in place of the cycles list.
- **Admin → Agent**: the level, the envelope, the limits per priority, the model (by hash), the approval queue, and *Ask the agent* (the question becomes an observation; the answer is read-only and nothing trades).
- **Performance → Analytics**: Grok against local (the dual decision), the shadow book against the live book, the quant forecasts against the AI's probability and the prior (Brier), results by model and prompt version.
- **Admin → System**: the history store, the backfills' progress, the model server.

## 12. Code layout

| Where | What |
| --- | --- |
| `packages/core` | what both bots mean the same thing by: the `agent` settings base, the observation and episode envelopes, the agent events both bots define identically |
| `packages/agent` → `@mb/agent` (new) | the runtime, generic over each bot's tools and decisions: the attention queue, the episode loop, the tool registry (arguments, output caps, the URL allowlist), watches, the envelope and breakers (pure functions, like the risk engine), the levels, the shadow book's bookkeeping, the journal, the local model client (GPU guard, model hash check) |
| `packages/history` → `@mb/history` (new) | the Postgres client, migrations, generic bar, series and archive tables, the archive and append jobs, the event-study SQL |
| `packages/engine-kit` | `AiRunner`'s local provider |
| `packages/wire` | the news read, the summaries on the llama.cpp server, and the embedding requests, in `enrich/` |
| `crypto-core`, `stock-core` | each bot's agent answer schema: its decision schema plus watches, notes and references |
| `apps/<bot>-engine/src/agent/` | the bot's tools, brief, salience rules and prompts, and the hand-off to its risk checks and execution |
| `apps/<bot>-engine/src/history/` | the bot's backfills and live appends |
| `apps/quant` (new, outside the pnpm workspace like the scraper) | Python with a uv lockfile, its own Dockerfile and tests: datasets, training, `/forecast`, embeddings |
| `compose.yml` | `llm` as llama.cpp across both GPUs (replacing Ollama), `history`, `quant`, the internal `ai` network, the `models` volume |

`@mb/agent` and `@mb/history` go into `SHARED` in `packages/config/eslint.mjs`; both may import `@mb/core` and `@mb/engine-kit`. No crypto code imports stock code, or the reverse.

## 13. Data model, settings and contracts

- **Settings**: a new `agent` section per bot (`level` 0, the envelope, the limits per priority, the model and its hash, `sweep_minutes`, the watch limits), and `ai.provider` (`gateway` or `local`) for the cycle paths during the switch. Changed only from Admin.
- **Atlas**: `agent_episodes` (summaries with a 30-day TTL; the trails of episodes that led to orders, permanent), `agent_watches`, `agent_notes`, `agent_approvals`, `shadow_positions` and `shadow_fills`. Decisions gain `agent_episode_id` and `source` (`grok`, `local`, `agent`, `shadow`).
- **The history store**: its own migrations, in `@mb/history` and each engine.
- **Events**: `agent.woke`, `agent.step` and `agent.thinking` (`seq: 0`; thinking owner-only by default), `agent.answered`, `agent.watch.*`, `agent.approval.*`, `agent.breaker`, `agent.level`.
- **Contracts**: every step that adds settings, events, indexes, prompts or schemas changes the `contracts/<bot>/` snapshots on purpose, in its own commit with the reason ([AGENTS.md](../../AGENTS.md)). New snapshots: the agent prompts rendered for fixed briefs, the tool schemas, the answer schema, the envelope defaults.
- **Env**: `QUANT_URL` and `HISTORY_URL` (a secret: the ENGINE section); `LLM_URL` keeps its name and points at the new server. After the switch, `AI_GATEWAY_API_KEY` leaves `.env.<bot>.example` and the Vercel table in [SERVER.md §3.4](../SERVER.md#34-what-goes-into-each-vercel-project).
- **`compose.smoke.yml`** gets its own history databases (`<bot>_staging`) and boots with the agent at level 0.

## 14. Rollout

Each step is one commit, gated (`pnpm typecheck && pnpm test && pnpm lint && pnpm build`, plus `apps/quant`'s tests once it exists), boot-tested with `compose.smoke.yml` when it touches startup or compose, and deployed engine by engine. Nothing trades differently until the owner sets level 2.

**A. Foundations (no change to trading)**

0. **Spike** (a branch, not deployed):
   - both GPUs in Docker by UUID, and whether the monitor can move to the motherboard's graphics;
   - the llama.cpp image, and the driver's sysmem fallback switched off;
   - §5's candidates on the eval set (valid answers, tokens/s, episode latency with a scripted tool loop, at each thinking level), with a Jellyfin transcode running;
   - that each candidate thinks first and then answers under the grammar (§8.8);
   - a 48-hour soak test;
   - the PSU and power limits, and the Docker VM's memory after the upgrade to 32 GB.

   The results are added to this plan, and the owner picks the layout and the model.
1. **The history store and the news archive**: `history`, `@mb/history`, the nightly archive of `wire_items` and `wire_triggers` and their live append, the live 1-minute bars, the nightly backup of the news archive. This comes first because each day without it loses a day of news.
2. **Backfills**: Kraken's files and the gap fill, Alpaca's daily and minute bars, GDELT and EDGAR, the moves after each news item, the embeddings.
3. **The llama.cpp server** across both GPUs, taking the summaries over from Ollama, and `AiRunner`'s local provider.

**B. Measure on today's pipeline**

4. **Dual decision** (§10), crypto then stock.
5. **Perception**: every item read, its severity part shown but not counted. Counting it is a small behavior change for the owner to approve after a week of looking at it.

**C. Quant**

6. **Event studies and analogs**: as tools, and on the market pages.
7. **`apps/quant`**: setup forecasts and their walk-forward tests, shown on decisions.

**D. The agent, in shadow**

8. **`@mb/agent` and crypto's agent at level 1**, the shadow book, the breakers (recorded, not yet enforced) and the agent on the Live page; then **stock's**.
9. **The approval queue** and its Discord messages, ready for level 2.
10. **The shadow period**: ≥ 3 weeks per bot, with a weekly comparison in Analytics.

**E. Promotion** (per bot, crypto first; each level is the owner's change in Admin, not a deploy)

11. **Level 2**, then **level 3**, as §10's numbers allow. At level 2, `ai.provider: local` for the remaining cycle paths (the stock core review) and Grok's cycles off.
12. **Forecasts in the edge gate** (optional, a behavior change): after ≥ 4 weeks in which the forecasts' Brier score beats the AI's shrunk probability.
13. **Retire Grok**: once both bots have run ≥ 4 weeks at level 3, remove the gateway path, `@ai-sdk/xai` and the key; update CRYPTO.md, STOCK.md, ARCHITECTURE.md and SERVER.md.

Calendar time goes mostly to the shadow and proposing weeks, not the building: an agent entry without the owner's approval comes at least five weeks after step 8 is deployed on that bot.

## 15. Decisions for you

| # | Question | My recommendation |
| --- | --- | --- |
| 1 | Fully local, or keep Grok for anything? | **Settled: fully local, no Grok.** Grok keeps making today's decisions on each bot until its agent reaches level 2, so the bots are never left without decisions, and those decisions are the yardstick in §10. Nothing of Grok stays after step 13 |
| 2 | GPU layout | **One MoE model split across both cards** (§5). The fallback, a ~9B model alone on the 2080 SUPER, is only for the case where the split can't stay on the GPUs beside Jellyfin. If the motherboard's graphics are on, move the monitor there |
| 3 | RAM | **Settled: 32 GB.** The Docker VM grows to ~15.5 GiB by itself, with no `.wslconfig` needed. Set one only if step 0 shows memory pressure. Changing it restarts Docker, so every stack goes down for a few minutes: pick a quiet time, not during a seed run |
| 4 | Web search for the agent | **Not at first.** A self-hosted SearXNG container would give it a free `web_search` tool, but search results are the widest door for injected text. Add it if step 4 shows the web half of Grok's research matters |
| 5 | Which bot first | **Crypto**: it runs 24/7, so more events and faster evidence, and it has no options and a simpler book |
| 6 | History depth | **All of Kraken's 1-minute history for the universe; for stocks, daily bars for the scan universe and 1-minute bars for the top ~300, from 2016** |
| 7 | The envelope's starting values | **The table in §9** |
| 8 | The ceiling | **Level 3 for at least the first 3 months**; level 4 only by a later decision |
| 9 | Fine-tuning a model on our own history | **No.** It would be automatic learning in disguise, and easy to overfit on a few months of trades |

## 16. Costs

- **Grok today**: the default budgets allow up to $15 a day ($450 a month); the actual spend is in `ai_calls`. A full stock trading day cost about $3.80.
- **Local**: electricity. The two cards idle at ~30 W together. With both busy a third of the time (the split model uses both), that's about 80–130 W more on average, 2–3 kWh a day, roughly $9–14 a month at $0.15/kWh.
- **One-off**: a PSU, if the current one is under ~750 W. The RAM upgrade to 32 GB is already planned.
- **Disk**: under 50 GB on C: for the database, plus the news archive's backups (small: the news, not the bars).
- **The build**: this is the largest change since the merge.

## 17. Risks

| Risk | What we do |
| --- | --- |
| A local 8–20B model reasons worse than Grok, and knows nothing after its training cutoff | Narrow steps, pre-digested tools, numbers from the quant layer, and no authority until it has a forward record. If it never earns level 2, steps 1–7 still leave the bots with years of data, event studies and calibrated forecasts |
| Cheap thinking turns into overtrading | The envelope and the breakers limit actions, not thoughts |
| Losing Grok's live web and X search | The wire covers most of it; step 4 shows where the gaps are, so the tools (and SearXNG, decision 4) can fill them |
| An evaluation fooled by look-ahead | Only forward results (the dual decision, shadow) count for promotion; the eval set judges models on reliability only |
| Both bots want the GPU at the US open | One slot per bot; within a bot, a P0 preempts |
| Windows: updates, reboots, WSL stalls (one held a 4 s call for 27 s), cold loads (134 s) | Models stay loaded and the engines wait for readiness. Without the agent there are no new entries; protection and stops run as always |
| VRAM taken by Jellyfin or the desktop, or spilled into system RAM | The split leaves ~1 GB on the 3070 for them (more with the monitor moved); the GPU guard pauses work rather than letting it crawl; the driver's sysmem fallback is off; the 9B fallback keeps the agent on the headless card |
| One model across both cards: one failure stops all AI work | It stops only decisions and news reading. Protection, stops and the risk engine are code and run as always; the engines alert |
| Losing the history volume in a Docker or WSL reset | The news archive is backed up nightly to the repo folder; everything else can be fetched again by the backfills |
| A second language (Python) in the repo | Kept to `apps/quant`, behind one HTTP endpoint, with its own tests in the gate |
| Power and heat with both cards busy | Check the PSU; power-limit the 2080 SUPER |

## 18. Later (not in v1)

- **Conditional orders** the agent leaves resting ("buy if it breaks 182, with this stop"): only after level 3 has run for months, and even then code re-checks everything at trigger time.
- **Time-series foundation models** as another forecast, if they beat the trees out of sample.
- **Fine-tuning** (decision 9).
- **A shared macro dataset** both bots read (rates, VIX, the calendar), if the duplication grows. The bots stay separate at runtime.
- **Live trading**: never.

## 19. Testing

- **`@mb/agent`**: the queue (coalescing, priorities, cooldowns, preemption), watches, the envelope and breakers (every rule, like the risk engine's tests), the levels, and the episode loop driven by a scripted fake model. Recorded episodes replay to the same answer.
- **Tools**: each against the in-memory MongoDB and PGlite (Postgres in-process, with pgvector); the output caps; the URL allowlist; the untrusted fencing. The TimescaleDB-specific parts run against the staging database.
- **History**: migrations, idempotent backfills and appends, event-study SQL against fixed data, the archive running before the TTL.
- **Quant**: pytest, including a look-ahead test (no feature uses data from after its label starts), like the backtester's.
- **Contracts**: the snapshots in §13.
- **Eval** (`pnpm eval:agent`; it needs the GPU, so it isn't in the gate): runs the eval set against the configured model. Required before any model or prompt change goes live.
- Test counts only go up (1,084 on 2026-10-27).
