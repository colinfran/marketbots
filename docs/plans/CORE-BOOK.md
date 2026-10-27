# Plan: a long-term core book

Status: **approved on 2026-10-27**, with every recommendation in §12 taken. Being built in the steps of §11. Stock bot first, crypto second (phase 2).

## 1. Goal

Put a fixed share of each account into a handful of long-term holdings, each with a written reason. Keep the holdings for months and review them weekly instead of every 30 minutes. The current day and swing trading keeps running with the rest of the money.

The yardstick is **beating SPY over months**. A long-term book will have down days and down weeks; it is not built to make money every day.

Not in scope: live trading, options in the core book, shorting, margin.

## 2. Where things stand (Oct 26–27, the stock bot's first two days)

| | |
| --- | --- |
| Return | +0.11%, against about +1.3% for holding SPY |
| Bot's own buys | QQQ and NVDA on day 1, both as day trades and sold at the close (+$0.75 together) |
| Seed | SPY (3 shares) and DIA (4 shares), about 44% of the account |
| Cash | about 56% of the account |
| History it sees | about 3 months of daily bars: 20/50-day averages, 20-day high/low and return. No 200-day average, 52-week high, 6/12-month returns or fundamentals |
| Memory | the last 5 days' P&L and lessons, today's decisions, the thesis of each open position. No long-term view per stock |
| Cost of holding | each 30-minute cycle re-decides SPY and DIA (24 "hold" decisions on day 2) |

## 3. How it works

```
weekly (Mon 10:15 ET), or "Run core review now" in Admin
  1. long-term data (code)    1 year of daily bars for ~100 liquid names + theme tickers + holdings
  2. ranking (code)           trend filter + momentum + relative strength vs SPY → top 25
  3. research (Grok + search) the holdings' theses, the top candidates, the owner's themes
  4. decision (Grok)          keep / buy / trim / sell, each with a target weight, thesis and invalidation
  5. rules (code)             caps, cash, trade limits, stops; then sells and trims first, buys last
  6. record                   the review, every thesis, and what was passed over and why
```

Between reviews, the trading cycles leave core holdings alone. A holding leaves the book when:
- its stop is hit (a plain GTC stop resting at Alpaca);
- the weekly review sells it;
- a single-holding review, started by serious news about it, sells it.

## 4. Settings (new `core` section, Admin → Core book)

| Setting | Default | Meaning |
| --- | --- | --- |
| `core.enabled` | `false` | Off until you turn it on in Admin |
| `core.target_pct` | 50 | Share of equity the core book aims for |
| `core.band_pct` | 5 | Rebalance only when the book is off target by more than this |
| `core.min_holdings` / `core.max_holdings` | 4 / 8 | Diversification bounds |
| `core.max_holding_pct` | 15 | Cap per single stock, as % of equity |
| `core.max_index_etf_pct` | 25 | Cap per broad-index ETF (SPY, QQQ, DIA, IWM, VTI, VOO) |
| `core.max_theme_pct` | 50 | Most of the core book any one theme may hold |
| `core.stop_pct` | 15 | Initial stop below entry. Reviews may raise it, never lower it |
| `core.min_conviction` | 7 | Minimum conviction (1–10) for a core buy |
| `core.max_trades_per_review` | 6 | Buys + trims + sells per review |
| `core.review_weekday` / `core.review_time_et` | `mon` / `10:15` | When the weekly review runs |
| `core.universe_size` | 100 | Top names by dollar volume from the daily scan universe |
| `core.themes` | `[]` | Your long-term themes, one per line, e.g. `AI buildout: NVDA, AVGO, TSM` |

`DEFAULT_SETTINGS` gets these with `enabled: false`, so deploying changes nothing until you switch it on.

## 5. Choosing holdings

**Candidates**, built in code:
- the top `universe_size` names from the scan universe (it's built every morning, liquid stocks and ETFs over $5);
- the benchmark ETFs;
- every ticker named in a theme;
- the current core holdings.

**Long-term data**: one year of consolidated (SIP) daily bars. The free plan allows these once they're over 15 minutes old, and the scan universe already uses them. That's about 100 symbols × 260 bars, three or four paged requests, cached once a day. For each name, code computes:
- the 50- and 200-day averages, and whether price is above them;
- the 6-month return and the 12-month return excluding the last month (the standard momentum measure);
- return vs SPY over 3, 6 and 12 months;
- distance from the 52-week high, 60-day volatility, and the worst drawdown in the year;
- average dollar volume.

**Ranking**, in code:
- Trend filter: price above the 200-day average and the 50-day above the 200-day.
- Score: a rank-average of the 12-1 month and 6-month returns, each divided by volatility (floored at 15%, about the market's: on the first real ranking, a dollar fund up 2.8% on 4.9% volatility ranked 29th without it).
- The top 25, plus every theme ticker and holding (even ones that fail the filter, marked as such), go to Grok with their numbers.

**Themes**: you write them in Admin. Research checks each theme against current evidence: earnings and guidance, capex, demand. It can name tickers you didn't list, but only ones on the candidate list or ones that pass Alpaca's tradable check. A theme is a reason to look, not an order: Grok still has to make the case, and the theme cap applies.

**Fundamentals**: there's no fundamentals feed. Research looks up earnings trends, guidance and valuation context with web search and cites them. A free SEC EDGAR "company facts" feed could come later.

## 6. The weekly review

**What Grok gets:**
- the account and the core book: target, actual, cash;
- each holding's thesis, invalidation, entry, weight and P&L, plus the notes from past reviews;
- the ranked candidates with their long-term numbers;
- your themes;
- the last review's summary and its watch list;
- the research memo (full research, with web and X search).

**What it returns** (a new structured schema):
- `summary`, the plan for the book in a few sentences;
- `holdings[]`: symbol, `keep | buy | trim | sell`, target weight, thesis, invalidation, theme (or null), conviction 1–10, stop;
- `watch[]`: names it likes but isn't buying, with the reason and what would change its mind. This carries over to the next review.

**Rules enforced in code** (a decision that breaks one is rejected and recorded):
- every cap in §4, the trade limit, and the minimum conviction for buys;
- buys only with available cash above the cash reserve. Trading positions are never sold to make room;
- no buy on a circuit-breaker day (sells and trims still allowed);
- stops: a buy gets `stop_pct` below entry unless Grok gives a tighter daily level. A keep may raise the stop, never lower it;
- order: sells and trims first, then buys by conviction;
- **v1 never adds to an existing holding.** Underweight holdings stay underweight until a later version (see §13).

**First review**: SPY and DIA, bought by your seed, are adopted into the core book with their seed theses. The first review then reshapes the book toward the target, at most `max_trades_per_review` trades at a time.

## 7. Memory

- **Holdings** (`position_plans`, new fields): `book: "core" | "trading"`, `theme`, `last_reviewed_at`, and `notes[]` (each review's short verdict, newest last, capped at 12).
- **Reviews** (new `core_reviews` collection): the ranking, the research id, Grok's output, what code did with each decision, the watch list and the cost. Each review gets the previous one's summary and watch list.
- So a thesis like "AI capex keeps growing; sell if hyperscaler capex guidance gets cut" is written once, checked every week against new evidence, and kept with the holding.

## 8. Living alongside the trading book

| Area | Today | With the core book |
| --- | --- | --- |
| Trading cycles | decide every open position every cycle | core holdings show as read-only lines ("core, reviewed weekly"); code drops any trading decision about them |
| `max_open_positions` | counts every position | counts trading positions only; the core book has `max_holdings` |
| Trading buys | up to cash minus reserve | also capped so trading exposure stays under `100 − target_pct − cash_reserve_pct` % of equity, which leaves room for the core book |
| Protection | OCO (take-profit + stop) on every position | core holdings get a plain GTC stop, no take-profit, so a winner isn't sold at a target. Maintenance must recognize it |
| Overnight cap | `max_overnight_pct` counts every position | counts the trading book only |
| "Never adds to a position" | always | unchanged in v1 |
| News about a holding | event cycle reviews it | for a core holding, a negative trigger at `evaluate` severity or above starts a **single-holding review** with the weekly rules (may keep, trim or sell). Uses the event budget |
| Kill switch (−7% day) | liquidates everything | **decision for you (§12)**. My recommendation: liquidate the trading book only; core holdings keep their stops |
| P&L | one account number | fills are tagged with their book. `daily_stats` adds core and trading P&L; Analytics shows each book against SPY since the core book started |

## 9. Dashboard and Admin

- **Admin → Core book**: the settings in §4. Themes go in a multi-line box, one per line (a new field kind; commas inside a theme would break the existing comma-separated list field). Plus a "Run core review now" button (a new `core.review` command).
- **Core page** (new): target vs actual, the holdings with thesis, invalidation, weight, P&L and stop, the review history with each review's decisions and watch list, and the latest ranking.
- **Positions**: a core/trading badge on each position.
- **Analytics**: core and trading returns against SPY.
- Live stream: `core.review.started` and `core.review.completed` events.

## 10. Data model and contract changes

All are behavior changes, made in the approved commits listed in §11, each with its snapshot diff:

- `packages/core`: `CycleKind` gains `"core"`. That's a shared package, so both engines rebuild in that step. Crypto's behavior and snapshots should not change; if a crypto snapshot changes, stop.
- `packages/stock-core`:
  - the `core` settings section and `DEFAULT_SETTINGS`;
  - the core review schema and its normalizer;
  - the `core.review` command;
  - the events `core.review.started` / `core.review.completed`;
  - `PositionPlanDoc.book` / `theme` / `last_reviewed_at` / `notes`;
  - `CoreReviewDoc` and the `core_reviews` indexes;
  - fills and `daily_stats` per-book fields.
- Stock contract snapshots that will change: `default-settings.json`, `settings.schema.json`, `commands.schema.json`, `events.json`, `ai.schema.json`, `db.json`, and `prompts/`. The trading prompt changes for core lines, and a new core review prompt is added.
- Existing plans with no `book` field read as `"trading"`. The SPY/DIA plans move to `"core"` on the first review.

## 11. Rollout (each step is one commit, gated, then deployed)

1. **Settings and types, switched off.** The `core` settings, `CycleKind "core"`, the Admin section. Deploy the stock engine first so it migrates its settings, then the crypto engine (shared package), then push to `main` for the dashboards. Boot-test with `compose.smoke.yml` (settings migration runs at startup).
2. **Long-term data and ranking, display only.** The one-year bars cache, the metrics, and the ranking at premarket, stored and shown on the Core page; nothing trades. Also add the 200-day average and the 52-week high to the regular cycles' daily technicals (a few tokens per symbol; swing holds benefit too).
3. **The core review**, behind `core.enabled`:
   - the scheduler slot and the `core.review` command;
   - research and decision prompts and the schema;
   - code rules and execution, GTC stop protection;
   - `book` on plans, and adopting the seed holdings.
4. **Coexistence**: trading cycles skip core holdings, the split caps, the overnight cap and kill switch rules, single-holding reviews from news, per-book P&L.
5. **Dashboard**: the Core page, badges, Analytics.
6. **Switch on**: you set `core.enabled` in Admin, then press "Run core review now" while watching the live stream. After that it runs weekly.
7. **Crypto (phase 2)**: §14, after about two weeks of stock results.

Every core rule in §8 applies only while `core.enabled` is on, so steps 1–5 trade nothing new. The one exception is step 2's two extra numbers in the regular cycles, a small prompt change. Step 6 is the only step that trades.

## 12. Decisions for you

| # | Question | My recommendation |
| --- | --- | --- |
| 1 | Should a −7% day (kill switch) liquidate the core book too? | **No.** Liquidating long-term holdings on a crash day locks in the loss. Core holdings keep their own stops |
| 2 | Core stops | **Fixed 15% below entry, raised by reviews, never lowered.** A 15–20% trailing stop is the alternative, but it fires on normal corrections in names like NVDA |
| 3 | Review cadence | **Weekly, Monday 10:15 ET**, plus single-holding reviews on serious news |
| 4 | Add to a holding (buy more on a dip) in v1? | **Not in v1.** Adding means resizing the resting stop at Alpaca; do it once v1 has run a few weeks |
| 5 | Adopt the seed's SPY and DIA into the core book? | **Yes** |
| 6 | Single stocks and ETFs both allowed? | **Yes**, with the 15% / 25% caps |
| 7 | Stock AI budget | **Raise `ai.daily_budget_usd` to $7 in Admin.** A full trading day already costs about $3.80, more than the $3.50 the scheduled cycles get from $5 |
| 8 | Crypto | **After two weeks of stock results**, so the design is proven first |

## 13. Later (not in v1)

- Adding to holdings, and rebalancing up to target weights.
- A free fundamentals feed (SEC EDGAR company facts: revenue, margins, EPS growth).
- Recurring contributions (new cash going straight to the core book).
- Daily-loss limits measured on the trading book alone (today they use the whole account, so with a 50% core book a −5% market day costs the account about −2.5% on its own).

## 14. Crypto (phase 2, outline)

The same shape:
- a core share (default 50%) in BTC, ETH and up to four majors;
- ranked by the 200-day trend, 6/12-month momentum and returns relative to BTC;
- a weekly review with theses;
- the seed holdings (BTC, BNB, ETH) adopted.

What differs:
- The paper wallet's stops are run by the engine, not resting at a broker, so core stops live in the engine's protection loop.
- Crypto moves more, so the default stop is about 25%.
- The existing daily-trend strategy overlaps heavily. Phase 2 decides whether it is folded into the core book or kept for the trading book.

## 15. Costs

- **Weekly review**: about $0.50–0.80 (full research on ~25 candidates and the themes, plus one decision).
- **Single-holding reviews**: about $0.15 each, on the event budget.
- **Trading cycles get cheaper**: they no longer re-decide every core holding every 30 minutes.

Net: a little under the current daily spend, once the budget is raised as in §12.7.

## 16. Risks

- **Momentum reversals.** The names that rose most can fall fastest. The 15% stops, the theme cap and the weekly review limit the damage, but a book of trend-followers will have sharp drawdowns in a market turn.
- **Concentration.** Themes invite piling into one sector; `max_theme_pct` caps it.
- **Research quality.** Grok can be wrong about fundamentals. Only sources research actually retrieved can be cited, and every thesis has a written invalidation that the next review checks.
- **Paper fills** are kinder than real ones; for holdings kept for months that matters less than for day trades.
- **Data.** SIP daily bars are free only once they're 15+ minutes old, which is fine for a review that uses daily closes.

## 17. Testing

- Unit tests:
  - the metrics and ranking (fixed bar series with known returns and averages);
  - every code rule in §6 and §8;
  - adopting seed plans;
  - the scheduler slot (weekday, holidays, early closes, missed slot → next trading day);
  - the trading-cycle filter for core holdings;
  - per-book P&L.
- Contract snapshots regenerated only in the steps above, each diff reviewed.
- Test counts only go up.
- A boot test with `compose.smoke.yml` for step 1 and step 3.
- Before step 6, a dry run in staging (its own database and its own Alpaca paper keys, never the live ones): the review's proposed trades are logged, not placed.
