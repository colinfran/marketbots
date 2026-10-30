# Plan: a local AI agent for both bots

Status: **decisions taken on 2026-10-27**: every recommendation in §15, and no Grok at all once the agent takes over (decision 1). Step 0 of §14, the measurement spike, is done: its results and a recommendation are in [§5.1](#51-step-0-results-2026-102728). Its second round found that Qwen 3.6 at 2-bit fits both cards and runs as fast as gpt-oss-20b, and the owner picked it (2026-10-28). Step 3 is deployed (2026-10-28): llama.cpp serves it on both GPUs in place of Ollama, the article summaries run on it, and `AiRunner` takes `local/<alias>` models ([SERVER.md §9](../SERVER.md#9-the-local-model-server-llm)). Its 48-hour soak, in production, runs to 2026-10-30. Step 1 (the history store and the news archive) was built beside it on 2026-10-27, since it doesn't depend on the model: `@mb/history`, the `history` and `history-backup` services ([SERVER.md §3.6, §6.4](../SERVER.md#64-the-history-stores-volume-and-backups)). Step 2's bars are built and running: crypto's from Kraken's files, the gap since them rebuilt from trades, and a daily refresh ([SERVER.md §6.5](../SERVER.md#65-krakens-history-files-crypto-backfill)); stock's from Alpaca's SIP history since 2016 ([§6.6](../SERVER.md#66-alpacas-history-stock-backfill)). So are the moves after each news item (1 h, 1 d and 5 d, in `news_moves`). The news backfills (GDELT, EDGAR) and the embeddings are next. **Step 8 is built for both bots at once (2026-10-28)** and ships at level shadow, as the owner asked: [§8.9](#89-as-built-2026-10-28) has what was built and where it differs from this plan. Grok was removed (2026-10-28) before step 4 ran, so the dual decision is dropped: the agent's shadow book is compared with the timed cycles, which now run on the local model too, and with holding BTC or SPY. **Level auto is built (2026-10-29)**: on the owner's call the shadow period (§10) and the propose level are skipped, and at level auto the agent trades the paper accounts (stocks and options for the stock bot) and the timed cycles stop. [§8.10](#810-level-auto-2026-10-29) has what was built. **Agent only (2026-10-29/30)**: the shadow level, the shadow book, the timed cycles, the one-time seed, the crypto backtester and the stock core book are removed; the agent is the only decision-maker, a breaker pauses its entries until the owner resumes them, it has a web research tool, and the dashboards stream everything the model writes as it writes it. [§8.11](#811-agent-only-2026-102930) has what changed.

Both bots, crypto first. Paper trading only, as always.

## 1. Goal

Replace Grok with models that run on the server's two GPUs, and change how the bots think:

- **Event-driven, not timed.** The model wakes within seconds of something that matters (news, a price shock, a fill, a level it asked to watch) instead of every 15 or 30 minutes.
- **Years of data.** Price history, news history and the bots' own decisions and outcomes, reachable by the model while it decides.
- **Agent-like.** In each wake-up the model looks things up with tools, decides, and leaves itself watches and notes for later.
- **Bounded.** The model proposes; code disposes. Its authority grows only as it proves itself, and shrinks automatically when it misbehaves.

Not in scope: live trading, shorting, margin, leverage, options beyond the stock bot's defined-risk set, and models that rewrite their own rules or prompts.

## 2. Where things stand

**The AI on 2026-10-27**, when this plan was written (the timed cycles are gone since: [CRYPTO.md](../CRYPTO.md#the-agent), [STOCK.md](../STOCK.md#the-agent)):

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

The GPU guard the summaries already use applies to the whole server: the model must sit where its configuration puts it (wholly on the GPUs, unless the configuration places some experts in RAM), or the work pauses rather than crawling on the CPU. On Windows the NVIDIA driver can also spill CUDA memory into system RAM without telling anyone; step 0 found that Docker's WSL CUDA doesn't on this driver (§5.1), so the guard watches speed instead. The engines check the loaded model's hash against settings at boot and before each episode; a mismatch stops episodes.

**Rough capacity** (to be measured in step 0): an MoE model with ~3–4B active parameters, split across these cards, should generate 40–80 tokens/s per stream and read 1,000–2,500 tokens/s (less for the Qwen option, with experts in RAM). A typical episode (a 3k-token brief, five tool results, a 1k-token answer) then takes 20–45 s, which leaves room for well over 100 episodes an hour per bot. Today's bots run a handful of AI cycles an hour.

### 5.1 Step 0 results (2026-10-27/28)

Measured on the server with `pnpm --filter @mb/<bot>-engine eval` (the eval harness, `@mb/engine-kit/ai/eval`), a 4K→1080p NVENC transcode running on the 3070 throughout as Jellyfin's stand-in, and the live engines, backfills and gate sharing the machine.

**Setup findings**

- **GPUs by UUID**: Docker Desktop's `--gpus device=<uuid>` still shows both cards inside the container; pinning works with `CUDA_VISIBLE_DEVICES=<uuid>,<uuid>` (the order is the order given, 2080 SUPER first).
- **Usable VRAM is ~14.2 GB, not ~15.5**: inside WSL each card reports ~7.1 GB free, the 3070 included with the display on it. The monitor move (§5) would mostly matter for Jellyfin headroom. The CPU's own graphics are off (Windows lists only the two NVIDIA cards): turning them on is a BIOS change for the owner.
- **llama.cpp** (`ghcr.io/ggml-org/llama.cpp:server-cuda`, build 11913) runs both cards with `--fit on --fit-target 512,1024`, which places layers and, when needed, experts in RAM to keep 512 MB free on the 2080 SUPER and 1 GB on the 3070. Three slots share one 96k-token KV pool (`-kvu`, q8_0); flash attention on; `--load-mode none` (memory-mapped experts were paged in on first use: a 92-token prompt took 47 s).
- **Cold loads**: the CUDA driver compiles kernels on first use; with that cache kept on a volume (`CUDA_CACHE_PATH`), a load takes 29–55 s instead of 106–134 s.
- **Thinking, then the grammar**: all four candidates write their thinking first (`reasoning_content`) and only then the schema-constrained answer. A request switches thinking with `reasoning_effort` (gpt-oss: low / medium / high; Qwen and Gemma: on or off through `chat_template_kwargs.enable_thinking`).
- **The plan's GPU guard can't check placement**: llama-server doesn't report where its tensors sit, and `--fit` decides at load time. The guard that works whatever the cause is speed: every response carries its own tokens/s, so step 3 pauses model work when generation drops below a floor (normal is 40–50; a spilled or contended model does 15–20).

**The eval set** is every recorded decision there is: 44 crypto cycles and 29 stock reports, all since 2026-10-26, not "a few hundred" (§10); it grows as the bots run. Grok's answers in it: crypto 54 `no_trade` and 15 `hold`, no buys; stock 6 buys and 2 sells. Agreement with Grok is a sanity check, not a score.

**Decisions** (today's prompts and schemas, one call each; p50 / p95 wall time):

| Model, layout | Thinking | Valid | Crypto p50 / p95 | Stock p50 / p95 | Generates | Reads | Agrees with Grok (crypto) | Buys Grok didn't make |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **gpt-oss-20b**, both cards (0.9 GB of experts in RAM) | medium | 30/30 | 75 s / 140 s | 84 s / 178 s | 44 tok/s | 2,000 tok/s | 28/35 | 7 of 20 cycles; 6 stock trades in 10 reports where Grok made none |
| gpt-oss-20b | low | 10/10 | 22 s / 63 s | | 34 | 2,000 | 20/22 | 2 |
| gpt-oss-20b | high | 1/6 | 150 s for the valid one | | 55 | 1,300 | | five of six thought past 16k tokens and never answered |
| Gemma 4 26B-A4B (Google's QAT q4_0), both cards, 3–4 GB of experts in RAM | on / off | 6/6 | 262 s on; 69 s / 138 s off | | 19–20 | 330–500 | | 2 of 2 with thinking |
| Qwen 3.6 35B-A3B (UD-IQ4_XS), both cards, 5.3 GB of experts in RAM | off | 4/4 | 149 s / 228 s | | 18 | 320 | 9/9 | 0 |
| Qwen 3.5 9B (Q4_K_M), 2080 SUPER alone, 32k context | off | 6/6 | 89 s / 131 s | | 31 | 1,000 | 17/17 | 0 |

- **At 4-bit, only gpt-oss fits** (round 2, below, fits Qwen 3.6 at 2-bit). Gemma 4 and Qwen 3.6 push 3–5 GB of experts into this machine's DDR4 and lose 60–85% of their speed: 2.5–5 minutes a decision with thinking off, far more with it on. Qwen 3.5 9B alone on the 2080 SUPER needs a context of 32k or less (at 96k, 5 of its 33 layers went to the CPU and it ran at 17 tok/s), and its ~10k thinking tokens make thinking impractical.
- **Answer length, not thinking, sets most of the latency**: today's schemas make the model write 1,500–5,000 tokens (evidence lists for every symbol). At ~45 tok/s that alone is 30–110 s. The agent's answer schema (§8.4) has to be lean, P0's above all.
- **Low effort is fast and shallow**: asked whether 17 is prime, gpt-oss at low effort thought 19 tokens ("Need JSON answer.") and said no. Not for decisions; P0 runs at medium with a short answer instead.
- **High effort runs away**: five of six answers thought past the 16k-token cap (54–66k characters) and never answered. For P2/P3, medium with llama.cpp's `--reasoning-budget` (thinking capped, the answer forced) replaces "high".
- **gpt-oss trades more than Grok**: 7 buys in 20 crypto cycles where Grok bought nothing, 6 stock trades in 10 reports where Grok made none. Nothing says who is right yet; the dual decision (step 4) scores both, and the envelope and breakers (§9) exist for this.

**Episodes** (the scripted tool loop, §8.2, gpt-oss at medium):

| gpt-oss-20b | Runs | Valid | p50 / p95 | Notes |
| --- | --- | --- | --- | --- |
| Free, medium (tools offered, the answer allowed at once) | 8 | 8 | 61–91 s / 150 s | it never called a tool: today's brief already holds everything |
| Forced, medium (three tool steps, then the answer) | 3 | 3 | 244 s / 270 s | 2,000–7,500 thinking tokens per step: it re-thinks the whole decision every step |
| Free, low | 3 | 3 | 19 s / 24 s | no tool calls |
| Forced, low | 3 | 3 | 23 s / 26 s | the plan's 20–45 s estimate |

Prompt caching works as §5 assumed: each step reads only its ~100 new tokens; the other 6,500–8,500 come from the slot's cache. What a step costs is its thinking. The forced tool calls were thin, too (a `purpose` of "forecast" or "answer"): today's decision prompt was written for one answer, not for looking things up.

**For §8.2**: the limits there assume 20–45 s episodes. At medium effort a 4-step episode takes ~4 minutes on this hardware, so step 8 sets a thinking budget per step (somewhere between low's tens of tokens and medium's thousands, ~1k to start), keeps P0 to two steps, and writes the agent prompt for tool use. Even at a few minutes an episode, that's 15–60 episodes an hour per bot, against today's handful of cycles.

**No silent spill to system RAM**: asked to put ~18 GB on the two cards (`--fit off`, a 262k-token f16 KV cache), llama-server failed with `cudaMalloc failed: out of memory`. Docker's WSL CUDA doesn't fall back to system memory on this driver, so over-allocation fails loudly instead of crawling, and no NVIDIA Control Panel change is needed.

**Power and heat** (2.3 h of benchmarking, sampled every 10 s): both cards together averaged 138 W and peaked at 304 W. The 3070 peaked at 165 W and 79 °C. The **2080 SUPER peaked at 258 W and 91 °C, and was at 85 °C or more in 12% of samples**: it needs a power limit (`nvidia-smi -i 1 -pl 180` from an administrator shell; generating text is bound by memory bandwidth, so little speed is lost) or more airflow. The PSU's rating is still to be checked against ~300 W of GPUs plus the rest.

**Memory**: the Docker VM has 15.5 GiB (32 GB of RAM, no `.wslconfig`); llama-server with gpt-oss holds 2–3 GB of it. No change needed.

**Round 2: the larger models, compressed to fit** (2026-10-28). The owner wanted the stronger models, so step 0 tried Unsloth's dynamic quants of them (unsloth/Qwen3.6-35B-A3B-GGUF at `a483e9e6`, unsloth/gemma-4-26B-A4B-it-GGUF at `c099eb48`, each file checked against its SHA-256), sized to the ~14 GB the cards hold. The setup was the same as above, at the production context (96k) unless noted. The 2080 SUPER was capped at 180 W, and no transcode ran this time.

| Model, quant (file) | Thinking | Valid | Crypto p50 / p95 | Stock p50 / p95 | Generates | Reads | Agrees with Grok (crypto) | Buys Grok didn't make |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Qwen 3.6 35B-A3B UD-Q2_K_XL** (12.3 GB) | off | 15/15 | 48 s / 115 s | 55 s / 96 s | 44 tok/s | 1,085 tok/s | 22/22 | 0 in 10 cycles; no stock trades in 5 reports |
| Qwen 3.6 UD-Q2_K_XL | on | 6/6 | 164 s / 255 s | | 44 | 1,085 | 15/17 | 2 |
| Qwen 3.6 UD-IQ3_XXS (13.2 GB) | off | 15/15 | 73 s / 166 s | 90 s / 161 s | 29 | 720 | 21/22 | 1; 3 stock trades in 5 reports |
| Qwen 3.6 UD-IQ3_XXS | on | 6/6 | 303 s / 398 s | | 27 | | 16/17 | 1 |
| Qwen 3.6 UD-IQ3_XXS, 32k context | off | 10/10 | 54 s / 99 s | | 39 | 1,150 | 22/22 | 0 |
| Gemma 4 26B-A4B UD-IQ4_XS (13.6 GB) | off | 7/7 (stopped early) | 101 s / 218 s | | 15 | 450 | 14/17 | 3 |
| Gemma 4 UD-Q3_K_XL (12.9 GB) | off | 15/15 | 107 s / 160 s | 108 s / 132 s | 18 | 590 | 16/22 | 6 |
| gpt-oss-20b, again, at 180 W | medium | 10/10 | 57 s / 216 s | | 51 | 2,170 | 16/22 | 6 |

| Episodes (§8.2) | Free: valid, p50 | Forced (three tool steps, then the answer): valid, p50 / p95 |
| --- | --- | --- |
| **Qwen 3.6 UD-Q2_K_XL**, thinking off | 3/3, 43 s (no tool calls) | 3/3, 40 s / 47 s |
| Qwen 3.6 UD-IQ3_XXS, thinking off | 3/3, 100 s (no tool calls) | 3/3, 93 s / 114 s |
| gpt-oss-20b, medium (above) | 8/8, 61–91 s (no tool calls) | 3/3, 244 s / 270 s |

- **Qwen 3.6 at 2-bit fits, and runs as fast as gpt-oss.** At 12.3 GB it sits on the cards (the server holds ~1.7 GB of RAM, against 3.6 GB at 3-bit). It generates 44 tok/s and reads half as fast as gpt-oss (1,085 against ~2,100). Its hybrid attention keeps the 96k-token KV pool small.
- **The 2-bit compression barely changed its decisions.** On the same cycles, its crypto calls matched the 3-bit version's in 21 of 22 decisions (thinking off) and 16 of 17 (on), and the 4-bit version's (round 1) in 9 of 9. Nearly every call here is `no_trade` or `hold`, so this is a weak test. Step 4's dual decision is the real one.
- **Without thinking, Qwen 3.6 is as cautious as Grok**: no buys in 10 crypto cycles at 2-bit, against gpt-oss's 6–7. With thinking on, its decisions take ~3 minutes (~3,600 thinking tokens) and it bought twice in 6 cycles.
- **Its tool loops are fast**: 40 s for three tool steps and an answer with thinking off, against 244 s for gpt-oss at medium (which re-thinks at every step). That fits §8.2's 20–45 s assumption.
- **Gemma 4 is out on this hardware.** At 3-bit as at 4-bit it ran 14–18 tok/s: at the production context its KV cache, not its weights, spills it into RAM.
- **Qwen 3.6 at 3-bit nearly fits with a 32k context** (39 tok/s), but 32k shared by three slots is too small for thinking or long episodes.
- **The 180 W cap costs gpt-oss nothing**: 51 tok/s generating and 2,170 reading, against 44 and 2,040 at 250 W with a transcode running beside it. Over 3.5 hours of this round, the 2080 SUPER peaked at 88 °C and spent 3 of 1,253 samples at 85 °C or more (0.2%, against 12% uncapped). The gpt-oss stretch peaked at 162 W and 79 °C. Power readings briefly went past the cap (213 W at most), since the driver enforces it as an average. The card still reached 82–88 °C for a few samples at only 110–130 W, so its airflow is worth a look. The two cards together peaked at 288 W.

**Recommendation** (owner's call): **Qwen 3.6 35B-A3B UD-Q2_K_XL** (SHA-256 `96b9c0af…70dad7`) split across both cards with the setup above. Thinking off for P0 decisions and episode steps; thinking on, with a budget, for reviews. The GPU guard's floor sits around 35 tok/s (normal is 40–47; the same model partly in RAM ran 28–29). gpt-oss-20b stays downloaded as the alternative: switching is a file and a setting, and step 4's dual decision shows whether the stronger model at 2-bit actually decides better. Fallback: Qwen 3.5 9B alone on the 2080 SUPER, 32k context, thinking off. Not Gemma 4. A GPU with more memory would let Qwen 3.6 run at 4-bit or better.

Still open from step 0: the 48-hour soak (it runs as step 3's production setup) and the PSU's rating. The 2080 SUPER has run capped at 180 W since 2026-10-28. The startup task that keeps the cap across reboots is still for the owner to register ([SERVER.md §2](../SERVER.md#2-server-prerequisites-once)).

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

### 8.9 As built (2026-10-28)

Step 8 shipped for both bots in one go, at level shadow by default (the owner's call): the engine fills the new `agent` settings section from the defaults on its first boot, as the wire did. Where it differs from §8.1–§8.8:

- **Levels** are named: `off` and `shadow` (`agent.level`). Propose, auto and full come with the approval queue (step 9).
- **News** reaches the agent through the wire policy's `observe` hook: every candidate that passes the item's own gates (`itemGate`: fresh, not old news, confirmed for entries), once per item and rule. The session gate, cooldown and caps are the timed cycles'.
- **Limits per priority** (`agent.limits`): P0 4 steps / 60 s and P1 6 / 120 s without thinking; P2 8 / 240 s with 1,024 tokens of thinking, P3 12 / 600 s with 2,048. P0's 20 s was too short for even one lookup (step 0: ~40 s for three). Tool calls stop at 60% of the time, so the answer gets the rest.
- **No forced lookups.** A live check against the production server (2026-10-28) found a P1 episode without thinking called `quote` and `features` before answering (26 s, the brief read from the prompt cache), and a P2 episode with thinking answered at once (70 s). It also found the model writing `size_pct_of_max` as a fraction (0.5 for 50%); the agent's schema spells it out now, and its normalization reads 1 or less as a fraction.
- **Tools** (§8.3), per bot 11: `book`, `quote`, `features` and `depth` (crypto) or `technicals` (stock), `news`, `dossier`, `item` (a wire item's article summary, in place of `read_article`), `past_decisions`, `calendar`, `history` (daily bars from the history store) and `past_news` (archived news with the moves after it). `event_study`, `analogs` and `forecast` wait for steps 6–7; `option_menu` and `core_book` for options in the shadow book.
- **Stock trades stocks only** in the shadow book: options stay with the timed cycles until their menus and quotes are simulated.
- **Watch kinds**: price above or below, a % move, news at a severity, a time. Feature and market-series watches are later.
- **The shadow book** is an account derived from its fills (`shadow_positions`, `shadow_fills`), starting at `agent.shadow_starting_usd`; its day start and peak are kept in memory. Crypto fills at the paper wallet's fee and slippage, stock at the quote plus 5 bps, commission-free. The agent's decisions are not written to `decisions`, so the timed cycles' re-ask filter and Analytics are untouched.
- **The envelope's windows** are rolling (the last hour, the last 24 hours) in both bots.
- **Breakers** are recorded, streamed and alerted (once per day each), never enforced at level shadow. The model-hash breaker isn't built: llama.cpp doesn't report a file hash. A slow-model breaker (5 steps under 35 tokens/s) stands in for the GPU guard.
- **The journal**: MongoDB keeps a capped copy for 14 days, not 30 (the Atlas tier may be the free one), and for good once an episode changed the shadow book; the history store keeps every episode in full (`agent_episodes`, migration 5).
- **The dashboard**: Research → Agent (`/agent`, `/agent/<id>`) instead of the Live page's cycle panel, with *Ask the agent* on it; the Agent settings in Admin.

### 8.10 Level auto (2026-10-29)

The owner asked for the agent to take over: no timed cycles, running all day on what happens, with guardrails. The promotion path in §10 (three weeks of shadow, then propose, then auto) was skipped on that call; the approval queue (step 9) is not built. Built in three commits, each gated:

- **What its first day in shadow showed, fixed first.** An hour's commitment budget with less than 1% of equity left now counts as used up, so a spent budget refuses an entry (and keeps setups from waking it) instead of sizing it below the venue's minimum; 13 of the first day's 18 rejected crypto buys were that. A stop just past the allowed range is moved inside it; 5 more were that. One screen run is one wake-up listing its best five setups, so the agent compares them rather than saying yes to each.
- **Real time.** Crypto's screens run once each minute's bars arrive from Kraken, with an interval's candles fetched afresh just after it closes. The stock bot gained a setup screen on the price board's closed minutes (opening-range breakouts and new session highs on heavy volume), so it sees more than news. A held position's move is checked every 3–5 s. The fixed sweep became a quiet-time review: it comes only when nothing has woken the agent for `sweep_minutes`.
- **Level auto** (`AGENT_LEVELS`: off, shadow, auto). Each bot's `src/agent/live.ts` decides into the paper account through the cycles' own execution path: crypto's `processDecision` (with an optional cap from the envelope), stock's `executeDecisions` (one decision at a time, no default holds; options from an `option_menu` the agent loaded in the same episode). Decisions carry `agent_episode_id` and `trigger_kind: "agent"`. The timed cycles stop at auto: the schedulers skip them, news triggers are recorded as "handed to the agent" (the wire policy's `request` may answer `"agent"`), and *Run now* queues a P1 review the agent may act on. The one-time seed and the stock core book's reviews still run in the cycle slot, and the agent waits for them. Protection, marks, reconciliation, the drawdown halt, the daily loss limit and the stock overnight rules (now always, as the day's end) are unchanged.
- **Breakers enforced.** At auto a trip drops the agent to shadow (an audited settings change by `engine:agent-breaker`); the timed cycles don't come back: the engine's state keeps the demotion (`agent_demotion`) until the next promotion clears it. A slow model only pauses its entries. The total-loss breaker counts from the promotion, whose time and equity are kept in the engine's state (`agent_promotion`) across restarts. Refusals for their timing (outside the session, entries paused) no longer count toward the envelope and rejection-rate breakers.
- **After its first trades at auto (2026-10-29)**: the crypto agent bought a 19% spike without calling a single tool, though the screen said its catalyst needed verifying. Each SUBJECT in the brief now carries its latest 3 news items from the last 24 h (or says there are none), so the catalyst is in front of it either way (prompts v5). A watch identical to an active one is refused (it had set the same ETH and BTC watches 4–5 times). The cap of 3 decisions per answer now applies only to new entries: in a review of its 6 holdings the stock agent's last 3 holds were dropped, which would have thrown away a sale had one been there (prompts v6).
- **Where it differs from §9–§11**: the envelope counts only positions the agent opened against its open-position limit (it inherits the cycles' and the seed's, and manages them); there is no options premium-per-day limit beyond the bot's own options caps; every agent buy posts to Discord through the existing fill alerts, and its exits post with a link to the episode. Admin's level control asks for confirmation before auto.

### 8.11 Agent only (2026-10-29/30)

The owner's call after level auto's first day: only the agent, no shadow mode, and the dashboards show everything that happens, the model's thinking included, as it happens. Five decisions came with it:

1. **A breaker trip pauses new entries** until the owner resumes them (Agent page, `agent.resume_entries`, audited); exits, stops and targets go on. The pause is in the engine's state (`agent_pause`). An earlier demotion to shadow was turned into such a pause on the first boot after the deploy.
2. **A research tool** (`research`, `@mb/agent/wire-tools`) for P2 and P3 episodes only: one question, the search service's free engines only (never the metered providers or the proxy), the scraper, a memo with its sources, 45 s to 3 minutes within the episode's time.
3. **Removed**: the stock core book, the crypto backtester and the one-time seed, with their commands, events, pages and collections. The crypto strategy toggles stay, in Admin.
4. **Live thinking is owner-only** unless `agent.public_thinking` is on.
5. **Old data stays**: the cycles', reports', seed runs', core reviews' and the shadow book's documents remain in MongoDB, not shown; nothing is dropped.

What else changed:

- **Levels** are `off` and `on`. Stored `auto` became `on`, and `shadow` became `off` (`upgradeStoredSettings`), so the agent never turns itself on.
- **The timed cycles are gone** from both engines, with the old AI runner (`AiRunner`, its repair and eval), the event-cycle queue, the cycle and seed commands and events, and the settings only they read. *Run now* is now *Wake the agent* (`agent.review`, optionally about up to 5 symbols), a P1.
- **The live model feed** (`@mb/engine-kit/ai/monitor`, `model-server`): every model call, the agent's steps, its research and the article summaries alike, is announced (`llm.call`), streamed once a second (`llm.delta`: the thinking and the output written since the last one) and closed (`llm.done`); the server's slots come every second while someone watches (`llm.status`). A viewer who connects mid-call gets what the call has written so far. The Live and Agent pages show it; everything else refreshes every 2 seconds as before.
- **The dashboards** lost the research, strategies, backtests, core book and seed pages; the navigation is Live, Agent, Portfolio, Markets, Performance, About and Admin ([ARCHITECTURE.md](../ARCHITECTURE.md#the-dashboards-navigation)).

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
- **Env**: `QUANT_URL` and `HISTORY_URL` (a secret: the ENGINE section); `LLM_URL` keeps its name and points at the new server. After the switch, `AI_GATEWAY_API_KEY` leaves the env example and the Vercel table in [SERVER.md §3.4](../SERVER.md#34-what-goes-into-each-vercel-project).
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

4. **Dual decision** (§10), crypto then stock. *Dropped: Grok was removed first (2026-10-28).*
5. **Perception**: every item read, its severity part shown but not counted. Counting it is a small behavior change for the owner to approve after a week of looking at it.

**C. Quant**

6. **Event studies and analogs**: as tools, and on the market pages.
7. **`apps/quant`**: setup forecasts and their walk-forward tests, shown on decisions.

**D. The agent, in shadow**

8. **`@mb/agent` and crypto's agent at level 1**, the shadow book, the breakers (recorded, not yet enforced) and the agent on the Live page; then **stock's**. *Built for both bots at once, 2026-10-28 (§8.9).*
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
