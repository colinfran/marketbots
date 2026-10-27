import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { roundTo } from "@mb/crypto-core/math"
import type { EventFocus, WireItemDoc } from "@mb/crypto-core/wire"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import {
  CRYPTO_PROMPT_VERSION,
  CRYPTO_SEED_PROMPT_VERSION,
  cryptoDecisionPrompt,
  cryptoDecisionSystemPrompt,
  cryptoGapFillPrompt,
  cryptoResearchPrompt,
  cryptoSeedDecisionPrompt,
  cryptoSeedResearchPrompt,
  cryptoSeedSystemPrompt,
  eventSection,
  SEED_OWNER_LEAN,
  type CryptoDecisionInput,
  type CryptoSubject,
} from "../../src/ai/prompts"
import { classifyRegime, featuresForPrompt, type Features } from "../../src/market/features"
import { eventCandidates } from "../../src/orchestrator/crypto-cycle"
import { seedCandidate } from "../../src/orchestrator/seed"
import { assembleDossier, toRow } from "../../src/wire/dossier"
import { checkNoOrphans, matchContract, matchJson } from "./snapshot"

/**
 * Every prompt builder in src/ai/prompts.ts, rendered for one fixed, realistic cycle: Tuesday
 * 2026-10-27 at 13:45 UTC, a $10,000 paper wallet holding SOL, with BTC (trend) and ETH (momentum)
 * as screened candidates. The regime comes from classifyRegime over hand-written features, the
 * candidates' features from featuresForPrompt, the event candidate from eventCandidates, the seed
 * candidates from seedCandidate, the WIRE text from the real dossier builder (assembleDossier) and
 * the EVENT text from eventSection, as orchestrator/crypto-cycle.ts and seed.ts build them.
 * Everything is fixed: no clock, no randomness.
 */

const NOW = new Date("2026-10-27T13:45:00Z")
const S = DEFAULT_SETTINGS
const at = (iso: string) => new Date(iso)
const HOUR = 3_600_000

/** crypto-cycle.ts's dossier time label. */
const utcTime = (d: Date) => `${d.toISOString().slice(11, 16)}Z`

const features = (f: Omit<Features, "closes_1h" | "as_of" | "quote_age_s">): Features => ({ ...f, quote_age_s: 1.2, as_of: NOW.getTime() - 1_200, closes_1h: [] })

const FEATURES: Features[] = [
  features({
    symbol: "BTC/USD",
    price: 112_480.5,
    bid: 112_478.1,
    ask: 112_482.9,
    spread_bps: 0.4,
    ret_1h_pct: 0.62,
    ret_4h_pct: 1.48,
    ret_24h_pct: 2.91,
    ret_7d_pct: 5.37,
    ret_30d_pct: 9.84,
    ema20_1h: 111_905.2,
    ema50_1h: 111_210.75,
    ema20_4h: 110_640.3,
    ema50_4h: 108_975.6,
    sma50_1d: 106_420.15,
    sma200_1d: 98_310.4,
    trend_1h: "up",
    trend_4h: "up",
    trend_1d: "up",
    rsi14_1h: 64.2,
    rsi14_4h: 61.8,
    rsi14_1d: 58.9,
    atr_1h: 612.35,
    atr_pct_1h: 0.544,
    atr_pct_4h: 1.172,
    atr_pct_1d: 2.861,
    bb_lower_1h: 110_880.4,
    bb_upper_1h: 112_950.25,
    bb_pct_b_1h: 0.773,
    high_20x4h: 112_105,
    low_20x4h: 106_870.5,
    breakout_4h: true,
    vol_7d_pct: 38.4,
    vol_30d_pct: 42.7,
    volume_ratio_24h: 1.38,
    move_zscore_24h: 1.3,
  }),
  features({
    symbol: "ETH/USD",
    price: 4_012.35,
    bid: 4_012.1,
    ask: 4_012.6,
    spread_bps: 1.2,
    ret_1h_pct: 0.88,
    ret_4h_pct: 2.35,
    ret_24h_pct: 4.12,
    ret_7d_pct: 7.9,
    ret_30d_pct: 6.41,
    ema20_1h: 3_978.6,
    ema50_1h: 3_941.2,
    ema20_4h: 3_902.45,
    ema50_4h: 3_850.1,
    sma50_1d: 3_788.3,
    sma200_1d: 3_402.75,
    trend_1h: "up",
    trend_4h: "up",
    trend_1d: "up",
    rsi14_1h: 69.4,
    rsi14_4h: 66.1,
    rsi14_1d: 60.2,
    atr_1h: 31.42,
    atr_pct_1h: 0.783,
    atr_pct_4h: 1.611,
    atr_pct_1d: 3.954,
    bb_lower_1h: 3_921.8,
    bb_upper_1h: 4_031.5,
    bb_pct_b_1h: 0.825,
    high_20x4h: 3_995.2,
    low_20x4h: 3_760.4,
    breakout_4h: true,
    vol_7d_pct: 51.2,
    vol_30d_pct: 55.8,
    volume_ratio_24h: 1.71,
    move_zscore_24h: 1.41,
  }),
  features({
    symbol: "SOL/USD",
    price: 196.42,
    bid: 196.4,
    ask: 196.44,
    spread_bps: 2,
    ret_1h_pct: -0.35,
    ret_4h_pct: 0.41,
    ret_24h_pct: 1.06,
    ret_7d_pct: -2.18,
    ret_30d_pct: 11.25,
    ema20_1h: 196.85,
    ema50_1h: 195.9,
    ema20_4h: 194.7,
    ema50_4h: 192.15,
    sma50_1d: 188.4,
    sma200_1d: 171.3,
    trend_1h: "flat",
    trend_4h: "up",
    trend_1d: "up",
    rsi14_1h: 48.7,
    rsi14_4h: 55.3,
    rsi14_1d: 54.6,
    atr_1h: 1.84,
    atr_pct_1h: 0.937,
    atr_pct_4h: 2.014,
    atr_pct_1d: 5.122,
    bb_lower_1h: 194.9,
    bb_upper_1h: 198.6,
    bb_pct_b_1h: 0.411,
    high_20x4h: 201.3,
    low_20x4h: 188.05,
    breakout_4h: false,
    vol_7d_pct: 68.9,
    vol_30d_pct: 72.4,
    volume_ratio_24h: 0.94,
    move_zscore_24h: 0.28,
  }),
  features({
    symbol: "LINK/USD",
    price: 18.234,
    bid: 18.232,
    ask: 18.236,
    spread_bps: 2.2,
    ret_1h_pct: 1.95,
    ret_4h_pct: 4.6,
    ret_24h_pct: 6.82,
    ret_7d_pct: 3.1,
    ret_30d_pct: -4.75,
    ema20_1h: 17.81,
    ema50_1h: 17.52,
    ema20_4h: 17.39,
    ema50_4h: 17.44,
    sma50_1d: 17.9,
    sma200_1d: 16.85,
    trend_1h: "up",
    trend_4h: "flat",
    trend_1d: "flat",
    rsi14_1h: 74.1,
    rsi14_4h: 63.5,
    rsi14_1d: 55.2,
    atr_1h: 0.214,
    atr_pct_1h: 1.174,
    atr_pct_4h: 2.43,
    atr_pct_1d: 5.871,
    bb_lower_1h: 17.2,
    bb_upper_1h: 18.31,
    bb_pct_b_1h: 0.932,
    high_20x4h: 18.05,
    low_20x4h: 16.92,
    breakout_4h: true,
    vol_7d_pct: 81.3,
    vol_30d_pct: 79.6,
    volume_ratio_24h: 2.46,
    move_zscore_24h: 1.62,
  }),
]
const byFeature = new Map(FEATURES.map((f) => [f.symbol, f]))
const f = (symbol: string) => byFeature.get(symbol)!
const REGIME = classifyRegime(FEATURES)

const SUBJECTS: CryptoSubject[] = [
  { symbol: "BTC/USD", role: "candidate", note: "trend: 4h breakout above the 20-bar high with 1h and 4h EMAs stacked up" },
  { symbol: "ETH/USD", role: "candidate", note: "momentum: +4.1% in 24 h on 1.7× volume, RSI 69 (1h)" },
  { symbol: "SOL/USD", role: "held", note: "held since 2026-10-24T09:15Z; thesis: Firedancer mainnet rollout and ETF inflows support a move back to the 205 range high" },
]

const ACCOUNT = { mode: "paper", exposure_pct: 18.7, day_pnl_pct: 0.42, drawdown_pct: -1.85, open_positions: 1, new_entries_allowed: true }

const LIMITS = {
  max_position_pct: S.kraken.max_position_pct,
  risk_per_trade_pct: S.kraken.risk_per_trade_pct,
  min_reward_risk: S.kraken.min_reward_risk,
  min_edge_bps_after_costs: S.kraken.min_edge_bps,
  min_conviction: S.kraken.min_conviction,
  stop_range_pct: [S.kraken.min_stop_pct, S.kraken.max_stop_pct],
  fee_bps_per_side: S.kraken.taker_fee_bps,
}

const CANDIDATES = [
  { symbol: "BTC/USD", strategy: "trend", score: 68, signal: "4h breakout above the 20-bar high with 1h and 4h EMAs stacked up", stop_hint: 110_640.25, target_hint: 116_160.75, est_round_trip_cost_bps: 86 },
  { symbol: "ETH/USD", strategy: "momentum", score: 61, signal: "+4.1% in 24 h on 1.7× volume, RSI 69 (1h)", stop_hint: 3_917.9, target_hint: 4_201.25, est_round_trip_cost_bps: 88 },
].map((c) => ({ ...c, features: featuresForPrompt(f(c.symbol)) }))

const POSITIONS = [
  {
    symbol: "SOL/USD",
    review_reason: "scheduled review (every 240 min)",
    entry_price: 190.15,
    price: 196.42,
    pnl_pct: roundTo((196.42 / 190.15 - 1) * 100, 2),
    weight_pct: 18.7,
    stop: 183.4,
    target: 205,
    age_hours: roundTo((NOW.getTime() - at("2026-10-24T09:15:00Z").getTime()) / HOUR, 1),
    strategy: "trend",
    thesis: "Firedancer mainnet rollout and ETF inflows support a move back to the 205 range high",
    invalidation: "a daily close below 183",
    features: featuresForPrompt(f("SOL/USD")),
  },
]

const RECENT = [
  { symbol: "SOL/USD", at: "2026-10-24T09:14", action: "buy", conviction: 64, execution: "filled" },
  { symbol: "ETH/USD", at: "2026-10-26T17:45", action: "no_trade", conviction: 38, execution: "skipped" },
]

const TRACK_RECORD = [
  { strategy: "trend", trades: 14, win_rate_pct: 50, avg_return_pct: 0.82, profit_factor: 1.41 },
  { strategy: "momentum", trades: 6, win_rate_pct: 33.3, avg_return_pct: -0.21, profit_factor: 0.88 },
]

const MEMO = `## BTC/USD
- [FACT] US spot bitcoin ETFs took in $412M on Oct 26, the fourth straight day of inflows. (2026-10-27 08:10 UTC, https://www.theblock.co/data/etfs/bitcoin-etf/flows)
- [SPECULATION] X traders call the breakout a squeeze after funding flipped negative over the weekend. (2026-10-27 11:30 UTC, https://x.com/example/status/1)
## ETH/USD
- [CLAIM] A large treasury company says it bought 40,000 ETH; UNVERIFIED by a second source. (2026-10-27 07:55 UTC, https://www.coindesk.com/markets/2026/10/27/eth-treasury)
## SOL/USD
- no material news
## Macro & scheduled events
- [FACT] FOMC decision Wednesday 2026-10-28 18:00 UTC. (https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)
## Red flags & data gaps
- LINK/USD moved +6.8% with no news found.`

const wireItem = (i: Partial<WireItemDoc> & Pick<WireItemDoc, "_id" | "source" | "tier" | "kind" | "category" | "title" | "first_seen_at" | "severity">): WireItemDoc => ({
  cluster_id: i._id,
  summary: null,
  url: null,
  domain: null,
  symbols: [],
  published_at: i.first_seen_at,
  polarity: 0,
  severity_parts: {},
  confirmations: [],
  price_at_seen: {},
  meta: {},
  notable: false,
  notable_reasons: [],
  expires_at: new Date(i.first_seen_at.getTime() + 30 * 86_400_000),
  ...i,
})

const WIRE_ITEMS: WireItemDoc[] = [
  wireItem({
    _id: "w-btc-etf",
    source: "rss:theblock",
    tier: 2,
    kind: "news",
    category: "etf_decision",
    title: "Bitcoin ETFs log fourth straight day of inflows as BTC tops $112,000",
    url: "https://www.theblock.co/post/bitcoin-etf-inflows-fourth-day",
    domain: "theblock.co",
    symbols: ["BTC/USD"],
    first_seen_at: at("2026-10-27T08:12:00Z"),
    polarity: 1,
    severity: 58,
    confirmations: [{ domain: "coindesk.com", url: "https://www.coindesk.com/markets/2026/10/27/btc-etf-inflows", at: at("2026-10-27T08:40:00Z") }],
    price_at_seen: { "BTC/USD": 110_950 },
    article: {
      status: "ok",
      summary: "US spot bitcoin ETFs took in $412 million on Monday, their fourth straight day of inflows, according to Farside data cited by The Block. BlackRock's IBIT led with $291 million. Analysts quoted said the flows could continue if bitcoin holds above $110,000.",
      key_points: ["$412 million of inflows on Monday", "IBIT led with $291 million"],
      words: 640,
      model: "llama3.2:3b",
      ms: 4_100,
      at: at("2026-10-27T08:13:00Z"),
    },
  }),
  wireItem({
    _id: "w-eth-treasury",
    source: "finnhub_crypto",
    tier: 2,
    kind: "news",
    category: "treasury_buy",
    title: "Treasury firm says it added 40,000 ETH to its balance sheet",
    url: "https://www.coindesk.com/markets/2026/10/27/eth-treasury",
    domain: "coindesk.com",
    symbols: ["ETH/USD"],
    first_seen_at: at("2026-10-27T07:58:00Z"),
    polarity: 1,
    severity: 62,
    price_at_seen: { "ETH/USD": 3_921.4 },
    // Rejected by the number check: never reaches a prompt.
    article: { status: "rejected", reason: "numbers not in the article: 45,000", summary: "The firm added 45,000 ETH.", model: "llama3.2:3b", ms: 3_800, at: at("2026-10-27T07:59:00Z") },
  }),
  wireItem({
    _id: "w-sol-outage",
    source: "status_solana",
    tier: 1,
    kind: "venue",
    category: "venue_outage",
    title: "Solana: Degraded RPC performance (resolved)",
    url: "https://status.solana.com/incidents/abc123",
    domain: "status.solana.com",
    symbols: ["SOL/USD"],
    first_seen_at: at("2026-10-27T03:20:00Z"),
    polarity: -1,
    severity: 34,
    price_at_seen: { "SOL/USD": 197.9 },
  }),
  wireItem({
    _id: "w-fed",
    source: "gov:fed",
    tier: 1,
    kind: "macro",
    category: "macro_release",
    title: "Federal Reserve Board announces the agenda for the October FOMC press conference",
    url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261027a.htm",
    domain: "federalreserve.gov",
    first_seen_at: at("2026-10-27T12:02:00Z"),
    severity: 41,
  }),
  wireItem({
    _id: "w-fng",
    source: "fng",
    tier: 3,
    kind: "sentiment",
    category: "sentiment_spike",
    title: "Crypto Fear & Greed index enters Extreme Greed: 78",
    url: "https://alternative.me/crypto/fear-and-greed-index/",
    domain: "alternative.me",
    first_seen_at: at("2026-10-27T00:05:00Z"),
    severity: 22,
    meta: { metric: "fng" },
  }),
  wireItem({
    _id: "w-btc-anomaly",
    source: "anomaly",
    tier: 1,
    kind: "anomaly",
    category: "price_shock",
    title: "BTC/USD 1-minute move +0.9% (z 4.6) on 3.2× volume",
    symbols: ["BTC/USD"],
    first_seen_at: at("2026-10-27T13:31:00Z"),
    polarity: 1,
    severity: 52,
    meta: { metric: "anomaly:BTC/USD" },
  }),
  wireItem({
    _id: "w-cpi-calendar",
    source: "macro_ff",
    tier: 3,
    kind: "calendar",
    category: "macro_release",
    title: "Scheduled: US Core PCE Price Index m/m at 2026-10-30T12:30:00Z",
    first_seen_at: at("2026-10-27T06:00:00Z"),
    severity: 15,
    meta: { event_at: "2026-10-30T12:30:00.000Z" },
  }),
  wireItem({
    _id: "w-eth-copy",
    cluster_id: "w-eth-treasury",
    source: "rss:decrypt",
    tier: 2,
    kind: "news",
    category: "treasury_buy",
    title: "Treasury firm adds 40,000 ETH (syndicated copy)",
    url: "https://decrypt.co/eth-treasury-copy",
    domain: "decrypt.co",
    symbols: ["ETH/USD"],
    first_seen_at: at("2026-10-27T08:05:00Z"),
    severity: 40,
  }),
]

const PRICES: Record<string, number> = { "BTC/USD": 112_480.5, "ETH/USD": 4_012.35, "SOL/USD": 196.42, "LINK/USD": 18.234 }

const dossier = (symbols = SUBJECTS.map((s) => s.symbol)) =>
  assembleDossier(WIRE_ITEMS, { symbols, since: new Date(NOW.getTime() - 72 * HOUR), now: NOW, price: (s) => PRICES[s] ?? null, timeLabel: utcTime, reviewThreshold: S.wire.thresholds.review })

const EVENTS: EventFocus[] = [
  { symbol: "LINK/USD", rule: "evaluate", action: "evaluate", severity: 74, polarity: 1, item_ids: ["w-link-listing"], trigger_id: "t-1", headline: "Coinbase lists LINK perpetuals for US customers (T1 coinbase.com, +2 confirmations)" },
  { symbol: null, rule: "market_review", action: "market_review", severity: 71, polarity: 0, item_ids: ["w-fed"], trigger_id: "t-2", headline: "Fed announces an unscheduled press conference at 15:00 UTC" },
]
const EVENT = eventSection(EVENTS.map((e) => ({ rule: e.rule, headline: e.headline, severity: e.severity, symbol: e.symbol })))
/** eventCandidates as crypto-cycle.ts calls it: SOL is held. */
const EVENT_CANDIDATES = eventCandidates(EVENTS, FEATURES, new Set(["SOL/USD"]), S)

const decisionInput = (over: Partial<CryptoDecisionInput> = {}): CryptoDecisionInput => ({
  now: NOW,
  regime: REGIME,
  account: ACCOUNT,
  limits: LIMITS,
  candidates: CANDIDATES,
  positions: POSITIONS,
  recent: RECENT,
  trackRecord: TRACK_RECORD,
  memo: MEMO,
  researchError: null,
  ...over,
})

/** Seed candidates as seed.ts builds them: every unheld universe pair with features, through seedCandidate. */
const SEED_CANDIDATES = FEATURES.filter((x) => x.symbol !== "SOL/USD").map((x) => seedCandidate(x, S))
const SEED_SUBJECTS: CryptoSubject[] = SEED_CANDIDATES.map((c) => ({ symbol: c.symbol, role: "candidate", note: c.signal }))
const SEED_INPUT = {
  now: NOW,
  regime: REGIME,
  amountUsd: 5_000,
  account: { mode: "paper", equity_usd: 10_212.48, cash_usd: 8_302.77, open_positions: 1 },
  limits: {
    max_position_pct: S.kraken.max_position_pct,
    max_total_exposure_pct: S.kraken.max_total_exposure_pct,
    max_correlated_exposure_pct: S.kraken.max_correlated_exposure_pct,
    stop_range_pct: [S.kraken.min_stop_pct, S.kraken.max_stop_pct],
    fee_bps_per_side: S.kraken.taker_fee_bps,
  },
  candidates: SEED_CANDIDATES.map((c) => ({ symbol: c.symbol, signal: c.signal, stop_hint: roundTo(c.stop_hint, 6), target_hint: roundTo(c.target_hint, 6), features: featuresForPrompt(f(c.symbol)) })),
  held: ["SOL/USD"],
  memo: MEMO,
  researchError: null,
}

const EVENT_SUBJECTS: CryptoSubject[] = [...EVENT_CANDIDATES.map((c) => ({ symbol: c.symbol, role: "candidate" as const, note: `${c.strategy}: ${c.signal}` })), SUBJECTS[2]]

const PROMPTS: Record<string, () => string> = {
  "research.txt": () => cryptoResearchPrompt({ now: NOW, regime: REGIME, subjects: SUBJECTS }),
  "gap-fill.txt": () => cryptoGapFillPrompt({ now: NOW, regime: REGIME, subjects: SUBJECTS, wire: dossier().text }),
  "gap-fill-event.txt": () => cryptoGapFillPrompt({ now: NOW, regime: REGIME, subjects: EVENT_SUBJECTS, wire: dossier(EVENT_SUBJECTS.map((s) => s.symbol)).text, event: EVENT }),
  "gap-fill-empty-wire.txt": () => cryptoGapFillPrompt({ now: NOW, regime: REGIME, subjects: SUBJECTS, wire: "" }),
  "event.txt": () => EVENT,
  "wire-dossier.txt": () => dossier().text,
  "decision-system.txt": () => cryptoDecisionSystemPrompt(),
  "decision.txt": () => cryptoDecisionPrompt(decisionInput()),
  "decision-wire.txt": () => cryptoDecisionPrompt(decisionInput({ wire: dossier().text })),
  "decision-event.txt": () =>
    cryptoDecisionPrompt(
      decisionInput({
        candidates: EVENT_CANDIDATES.map((c) => ({ symbol: c.symbol, strategy: c.strategy, score: c.score, signal: c.signal, stop_hint: roundTo(c.stop_hint, 6), target_hint: roundTo(c.target_hint, 6), est_round_trip_cost_bps: 90, features: featuresForPrompt(f(c.symbol)) })),
        recent: [],
        wire: dossier(EVENT_SUBJECTS.map((s) => s.symbol)).text,
        event: EVENT,
        memo: "",
        researchSkipped: "event cycle with event_research none: the dossier is the evidence",
      }),
    ),
  "decision-research-unavailable.txt": () => cryptoDecisionPrompt(decisionInput({ memo: "", researchError: "research timed out after 180 s", wire: dossier().text })),
  "decision-research-unavailable-no-wire.txt": () => cryptoDecisionPrompt(decisionInput({ memo: "", researchError: null, positions: [], account: { mode: "paper" } })),
  "decision-research-skipped.txt": () => cryptoDecisionPrompt(decisionInput({ memo: "   ", wire: dossier().text, researchSkipped: "no unexplained moves or unconfirmed items, and X was read 40 min ago" })),
  "seed-research.txt": () => cryptoSeedResearchPrompt({ now: NOW, regime: REGIME, subjects: SEED_SUBJECTS, amountUsd: SEED_INPUT.amountUsd }),
  "seed-system.txt": () => cryptoSeedSystemPrompt(),
  "seed-decision.txt": () => cryptoSeedDecisionPrompt(SEED_INPUT),
  "seed-decision-research-unavailable.txt": () => cryptoSeedDecisionPrompt({ ...SEED_INPUT, held: [], memo: "", researchError: "gateway error 503" }),
}

describe("contracts: prompts", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  for (const name of Object.keys(PROMPTS)) {
    it(name, () => matchContract(`prompts/${name}`, `${PROMPTS[name]()}\n`))
  }

  it("prompt versions, constants and the derived fixture inputs", () => {
    const d = dossier()
    matchJson("prompts/meta.json", {
      prompt_version: CRYPTO_PROMPT_VERSION,
      seed_prompt_version: CRYPTO_SEED_PROMPT_VERSION,
      seed_owner_lean: SEED_OWNER_LEAN,
      regime: REGIME,
      event_candidates: EVENT_CANDIDATES,
      seed_candidates: SEED_CANDIDATES,
      dossier: {
        items: d.items.map((i) => i._id),
        unexplained: d.unexplained.map((i) => i._id),
        unconfirmed: d.unconfirmed.map((i) => i._id),
        calendar: d.calendar,
        urls: d.urls,
        id_by_url: d.idByUrl,
        rows: d.rows,
        to_row: toRow(WIRE_ITEMS[0]),
      },
    })
  })

  it("no stale snapshots", () => checkNoOrphans("prompts", [...Object.keys(PROMPTS), "meta.json"]))
})
