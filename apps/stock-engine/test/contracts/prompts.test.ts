import type { MarketContext } from "@mb/stock-core/context"
import { DEFAULT_SETTINGS, type Phase, type Settings } from "@mb/stock-core/settings"
import { formatTime } from "@mb/stock-core/time"
import type { WireItemDoc } from "@mb/stock-core/wire"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { decisionPrompt, decisionSystemPrompt, eventSection, PROMPT_VERSION, renderContext, researchGapFillPrompt, researchPrompt, SEED_OWNER_LEAN, seedStopPct } from "../../src/ai/prompts"
import { assembleDossier, toRow } from "../../src/wire/dossier"
import { checkNoOrphans, matchContract, matchJson } from "./snapshot"

/**
 * Every prompt builder in src/ai/prompts.ts, rendered for one fixed, realistic cycle: Tuesday
 * 2026-10-27 at 11:00 ET (15:00Z), a $10,000 paper account holding NVDA shares and an NVDA call
 * spread, with AMD and SOFI on the watchlist. The WIRE text comes from the real dossier builder
 * (assembleDossier) over a few hand-written wire items, and the EVENT text from eventSection, as
 * bot/cycle.ts builds them. Everything is fixed: no clock, no randomness.
 */

const NOW = new Date("2026-10-27T15:00:00Z")
const S = DEFAULT_SETTINGS
const at = (iso: string) => new Date(iso)

const quote = (symbol: string, price: number, prev: number, open: number, high: number, low: number, vwap: number, volume: number): MarketContext["benchmarks"][number] => ({
  symbol,
  price,
  change_pct: Math.round((price / prev - 1) * 10_000) / 100,
  prev_close: prev,
  open,
  high,
  low,
  day_vwap: vwap,
  iex_volume: volume,
  last_trade_et: "10:59:58 AM",
})

/** The intraday context; other phases change the clock, session and phase only. */
const CONTEXT: MarketContext = {
  generated_at: "2026-10-27T15:00:00.000Z",
  now_et: "11:00 AM",
  trading_day: "2026-10-27",
  phase: "intraday",
  session: { open_et: "09:30", close_et: "16:00", is_open: true, early_close: false, minutes_to_open: null, minutes_to_close: 300 },
  risk: {
    equity: 10_412.35,
    cash: 6_118.2,
    start_of_day_equity: 10_365.8,
    day_pnl: 46.55,
    day_pnl_pct: 0.45,
    total_return_pct: 4.12,
    deployable_cash: 5_597.58,
    max_position_pct: 20,
    max_position_usd: 2_082.47,
    open_positions: 1,
    max_open_positions: 6,
    trades_today: 2,
    trades_remaining: 28,
    circuit_breaker: false,
    profit_lock: false,
    kill_switch: false,
    new_buys_allowed: true,
    notes: [],
    min_conviction: 6,
    max_new_buys_this_cycle: 3,
    rebuy_cooldown_minutes: 30,
  },
  positions: [
    {
      symbol: "NVDA",
      qty: 12,
      avg_entry: 138.4,
      price: 142.15,
      market_value: 1_705.8,
      unrealized_pl: 45,
      unrealized_pl_pct: 2.71,
      today_pl_pct: 1.18,
      stop_loss: 134.9,
      take_profit: 152,
      horizon: "multi_day",
      thesis: "Daily uptrend above sma20/sma50 after the data-center beat; pullback to sma20 held.",
      invalidation: "Daily close below 134.90 (sma50).",
      opened_at_et: "10:12 AM",
      opened_on: "2026-10-22",
      has_exit_orders: true,
    },
  ],
  open_orders: [{ symbol: "NVDA", side: "sell", type: "stop", qty: 12, limit_price: null, stop_price: 134.9, status: "accepted" }],
  benchmarks: [quote("SPY", 584.22, 581.9, 582.1, 585.03, 581.4, 583.6, 812_400), quote("QQQ", 512.8, 509.75, 510.2, 513.4, 509.1, 511.95, 655_100), { symbol: "VIXY", price: null, change_pct: null, prev_close: 14.2, open: null, high: null, low: null, day_vwap: null, iex_volume: null, last_trade_et: null }],
  instruments: [
    {
      symbol: "NVDA",
      tags: ["held", "watchlist"],
      quote: quote("NVDA", 142.15, 140.49, 140.9, 142.6, 140.3, 141.7, 2_104_300),
      intraday: { vwap: 141.7, pct_from_vwap: 0.32, opening_range_high: 141.6, opening_range_low: 140.3, day_high: 142.6, day_low: 140.3, rsi14_5m: 61.4, ema9_5m: 141.98, ema21_5m: 141.52, trend_5m: "up", change_30m_pct: 0.41 },
      daily: { sma20: 137.8, pct_from_sma20: 3.16, sma50: 134.9, pct_from_sma50: 5.37, sma200: 121.4, pct_from_sma200: 17.09, high_52w: 153.13, pct_from_high_52w: -7.17, return_5d_pct: 2.8, return_20d_pct: 6.4, atr14: 3.62, atr_pct: 2.55, high_20d: 143.1, low_20d: 128.7, rsi14_daily: 58.9 },
    },
    {
      symbol: "AMD",
      tags: ["watchlist"],
      quote: quote("AMD", 158.4, 160.02, 159.8, 160.5, 157.9, 158.95, 1_010_200),
      intraday: { vwap: 158.95, pct_from_vwap: -0.35, opening_range_high: 160.5, opening_range_low: 158.6, day_high: 160.5, day_low: 157.9, rsi14_5m: 42.7, ema9_5m: 158.6, ema21_5m: 158.9, trend_5m: "down", change_30m_pct: -0.22 },
      daily: { sma20: 155.1, pct_from_sma20: 2.13, sma50: 150.6, pct_from_sma50: 5.18, sma200: 141.2, pct_from_sma200: 12.18, high_52w: 187.28, pct_from_high_52w: -15.42, return_5d_pct: -1.1, return_20d_pct: 4.9, atr14: 4.8, atr_pct: 3.03, high_20d: 163.2, low_20d: 146.4, rsi14_daily: 54.2 },
    },
    { symbol: "SOFI", tags: ["watchlist", "requested"], quote: quote("SOFI", 17.82, 16.9, 17.05, 17.95, 17.01, 17.6, 3_880_000), intraday: null, daily: null },
  ],
  movers: {
    gainers: [{ symbol: "SMCI", price: 41.2, change_pct: 12.5 }],
    losers: [{ symbol: "INTC", price: 20.15, change_pct: -6.2 }],
    most_active: [{ symbol: "TSLA", price: 251.3, change_pct: null, iex_volume: 1_204_000 }],
  },
  news: [{ at_et: "10:41 AM", symbols: ["SOFI"], headline: "SoFi raises full-year member growth outlook", source: "benzinga", url: "https://www.benzinga.com/news/26/10/sofi-outlook" }],
  options: {
    enabled: true,
    new_positions_allowed: true,
    premium_open_usd: 186,
    premium_open_pct: 1.79,
    max_total_premium_pct: 15,
    max_premium_per_trade_pct: 2,
    max_premium_per_trade_usd: 208.25,
    open_positions: 1,
    max_open_positions: 4,
    min_conviction: 7,
    allow_spreads: true,
    dte_range: [14, 45],
    delta_range: [0.3, 0.7],
    default_stop_loss_pct: 50,
    default_take_profit_pct: 100,
    positions: [
      {
        id: "opt-nvda-1120-140-150",
        underlying: "NVDA",
        strategy: "call_debit_spread",
        legs: ["NVDA261120C00140000", "NVDA261120C00150000"],
        contracts: 1,
        paid: 1.86,
        value: 2.31,
        pnl_usd: 45,
        pnl_pct: 24.19,
        dte: 24,
        underlying_price: 142.15,
        stop_loss_pct: 50,
        take_profit_pct: 100,
        underlying_stop: 134.9,
        underlying_target: 150,
        thesis: "Defined-risk upside into the November product event.",
        opened_at_et: "Oct 23, 2:05 PM",
      },
    ],
    chains: [
      {
        underlying: "AMD",
        price: 158.4,
        contracts: [
          { symbol: "AMD261120C00160000", type: "call", expiration: "2026-11-20", dte: 24, strike: 160, bid: 6.1, ask: 6.3, mid: 6.2, spread_pct: 3.23, delta: 0.47, iv: 0.42, open_interest: 8_210 },
          { symbol: "AMD261120C00170000", type: "call", expiration: "2026-11-20", dte: 24, strike: 170, bid: 2.85, ask: 3, mid: 2.93, spread_pct: 5.13, delta: 0.27, iv: 0.4, open_interest: 6_530 },
          { symbol: "AMD261120P00150000", type: "put", expiration: "2026-11-20", dte: 24, strike: 150, bid: 3.4, ask: 3.55, mid: 3.48, spread_pct: 4.32, delta: -0.31, iv: null, open_interest: null },
        ],
      },
    ],
    notes: [],
  },
  briefing: {
    headline: "Chips lead into CPI week; buy pullbacks in leaders",
    summary: "Futures firm after Asia; semis strong on AI capex headlines. CPI Thursday caps risk appetite late in the week.",
    stance: "normal",
    watchlist: [
      { symbol: "AMD", setup: "pullback", trigger: "Holds VWAP after the first pullback with SMH green", stop_loss: 155.2, take_profit: 166, conviction: 6 },
      { symbol: "SOFI", setup: "catalyst", trigger: "Holds 17.40 after the outlook raise", stop_loss: 17.05, take_profit: 19.2, conviction: 5 },
    ],
  },
  previous_cycle: { at_et: "10:30 AM", phase: "intraday", headline: "Semis bid; NVDA holding above VWAP", next_focus: "AMD reclaim of 159.00; SOFI 17.40 hold" },
  requested: ["SOFI"],
  today: {
    decisions: [{ at_et: "10:30 AM", symbol: "NVDA", action: "hold", status: "skipped", reason: null }],
    fills: [{ at_et: "9:41 AM", symbol: "XLE", side: "sell", qty: 10, price: 91.35, role: "exit", realized_pnl: 12.4 }],
    realized_pnl: 12.4,
  },
  memory: {
    recent_days: [
      { day: "2026-10-26", pnl: 38.2, pnl_pct: 0.37, spy_pct: 0.21, lessons: ["Waited for the first pullback on gap-ups: two clean entries."] },
      { day: "2026-10-23", pnl: -61.5, pnl_pct: -0.59, spy_pct: -0.44, lessons: ["Held an intraday loser past its stop; respect the stop."] },
    ],
    profitable_days: 6,
    total_days: 9,
  },
}

const PHASE_CLOCK: Record<Phase, Pick<MarketContext, "now_et" | "phase" | "session" | "generated_at">> = {
  premarket: { now_et: "8:00 AM", phase: "premarket", generated_at: "2026-10-27T12:00:00.000Z", session: { ...CONTEXT.session, is_open: false, minutes_to_open: 90, minutes_to_close: null } },
  intraday: { now_et: CONTEXT.now_et, phase: "intraday", generated_at: CONTEXT.generated_at, session: CONTEXT.session },
  close: { now_et: "3:35 PM", phase: "close", generated_at: "2026-10-27T19:35:00.000Z", session: { ...CONTEXT.session, minutes_to_close: 25 } },
  postmarket: { now_et: "4:10 PM", phase: "postmarket", generated_at: "2026-10-27T20:10:00.000Z", session: { ...CONTEXT.session, is_open: false, minutes_to_close: null } },
}

const contextFor = (phase: Phase): MarketContext => ({ ...CONTEXT, ...PHASE_CLOCK[phase] })

/** Wire items as the Wire stores them (cluster roots), for the dossier. */
const item = (o: Partial<WireItemDoc> & Pick<WireItemDoc, "_id" | "source" | "tier" | "kind" | "category" | "title" | "symbols" | "severity" | "first_seen_at">): WireItemDoc => ({
  cluster_id: o._id,
  summary: null,
  url: null,
  domain: null,
  published_at: o.first_seen_at,
  polarity: 0,
  severity_parts: { base: o.severity, relevance: 0, confirmation: 0, anomaly: 0 },
  confirmations: [],
  price_at_seen: {},
  meta: {},
  notable: false,
  notable_reasons: [],
  expires_at: at("2026-11-26T00:00:00Z"),
  ...o,
})

const WIRE_ITEMS: WireItemDoc[] = [
  item({ _id: "w-nvda-8k", source: "edgar:8k", tier: 1, kind: "filing", category: "guidance", title: "NVDA 8-K: 7.01 Regulation FD Disclosure (updated data-center outlook)", symbols: ["NVDA"], severity: 72, first_seen_at: at("2026-10-27T13:05:00Z"), url: "https://www.sec.gov/Archives/edgar/data/1045810/0001045810-26-000101-index.htm", domain: "sec.gov", polarity: 1, price_at_seen: { NVDA: 140.2 } }),
  item({ _id: "w-nvda-cnbc", source: "rss:cnbc", tier: 2, kind: "news", category: "general", title: "Nvidia supplier checks point to stronger December quarter", symbols: ["NVDA"], severity: 36, first_seen_at: at("2026-10-27T14:20:00Z"), url: "https://www.cnbc.com/2026/10/27/nvidia-supplier-checks.html", domain: "cnbc.com", price_at_seen: { NVDA: 141.6 } }),
  item({ _id: "w-sofi-outlook", source: "finnhub", tier: 2, kind: "news", category: "guidance", title: "SoFi raises full-year member growth outlook", symbols: ["SOFI"], severity: 63, first_seen_at: at("2026-10-27T14:41:00Z"), url: "https://www.benzinga.com/news/26/10/sofi-outlook", domain: "benzinga.com", polarity: 1, price_at_seen: { SOFI: 17.3 }, article: { status: "ok", summary: "SoFi raised its full-year forecast for new members to 3.5 million from 3 million, the company said in a statement. Analysts at the firm's call said the raise could lift 2027 revenue estimates.", key_points: ["New-member forecast raised to 3.5 million from 3 million"], words: 410, model: "llama3.2:3b", ms: 3_200, at: at("2026-10-27T14:42:00Z") } }),
  item({ _id: "w-amd-anomaly", source: "anomaly", tier: 1, kind: "anomaly", category: "price_shock", title: "AMD -1.4% in 5 min (z 4.6 after removing SPY's move)", symbols: ["AMD"], severity: 58, first_seen_at: at("2026-10-27T14:48:00Z"), price_at_seen: { AMD: 159.9 } }),
  item({ _id: "w-fed-waller", source: "gov:fed_speeches", tier: 1, kind: "macro", category: "macro_release", title: "Waller: further rate cuts appropriate if inflation keeps easing", symbols: [], severity: 55, first_seen_at: at("2026-10-27T13:40:00Z"), url: "https://www.federalreserve.gov/newsevents/speech/waller20261027a.htm", domain: "federalreserve.gov", confirmations: [{ domain: "reuters.com", url: "https://www.reuters.com/markets/us/waller-2026-10-27", at: at("2026-10-27T13:52:00Z") }] }),
  item({ _id: "w-sofi-st", source: "stocktwits", tier: 3, kind: "sentiment", category: "sentiment_spike", title: "SOFI enters StockTwits trending (#2 of 30)", symbols: ["SOFI"], severity: 25, first_seen_at: at("2026-10-27T14:50:00Z") }),
  item({ _id: "w-amd-earnings", source: "calendar:earnings", tier: 1, kind: "calendar", category: "earnings", title: "Scheduled: AMD reports earnings 2026-10-28 after the close", symbols: ["AMD"], severity: 15, first_seen_at: at("2026-10-27T11:00:00Z"), meta: { event_at: "2026-10-28T20:05:00.000Z" } }),
  // A later copy of the 8-K story: not a cluster root, so the dossier skips it.
  item({ _id: "w-nvda-copy", cluster_id: "w-nvda-8k", source: "rss:marketwatch", tier: 2, kind: "news", category: "guidance", title: "Nvidia updates data-center outlook in filing", symbols: ["NVDA"], severity: 40, first_seen_at: at("2026-10-27T13:30:00Z") }),
]

const PRICES: Record<string, number> = { NVDA: 142.15, AMD: 158.4, SOFI: 17.82 }

const dossier = () =>
  assembleDossier(WIRE_ITEMS, {
    symbols: ["NVDA", "AMD", "SOFI"],
    since: new Date(NOW.getTime() - 24 * 3_600_000),
    now: NOW,
    price: (s) => PRICES[s] ?? null,
    timeLabel: (d) => formatTime(d),
    reviewThreshold: S.wire.thresholds.review,
  })

const EVENT = eventSection([
  { rule: "held_review", headline: "NVDA 8-K: 7.01 Regulation FD Disclosure (updated data-center outlook)", severity: 72, symbol: "NVDA" },
  { rule: "market_review", headline: "Waller: further rate cuts appropriate if inflation keeps easing", severity: 55, symbol: null },
])

const MEMO = `## 1. Tape & macro
- [FACT] S&P 500 +0.4%, Nasdaq 100 +0.6% at 10:55 ET; semis lead (SMH +1.3%). (10:55 ET, https://www.cnbc.com/markets/)
## 3. Held positions (stocks and option underlyings)
- NVDA: [FACT] 8-K updates the data-center outlook; shares +1.2% since. (09:05 ET, https://www.sec.gov/Archives/edgar/data/1045810/0001045810-26-000101-index.htm)
## 4. Watchlist, requested & movers
- SOFI: [CLAIM] member growth outlook raised; no 8-K yet, UNVERIFIED by a second source. (10:41 ET, https://www.benzinga.com/news/26/10/sofi-outlook)
## 7. Red flags & data gaps
- AMD 5-minute drop at 10:48 ET: no news found.`

const OPTIONS_OFF: Settings = { ...S, options: { ...S.options, enabled: false, allow_spreads: false } }

const PROMPTS: Record<string, () => string> = {
  "research-premarket.txt": () => researchPrompt("premarket", contextFor("premarket"), S),
  "research-intraday.txt": () => researchPrompt("intraday", contextFor("intraday"), S),
  "research-close.txt": () => researchPrompt("close", contextFor("close"), S),
  "research-postmarket.txt": () => researchPrompt("postmarket", { ...contextFor("postmarket"), previous_cycle: null }, S),
  "research-seed.txt": () => researchPrompt("intraday", contextFor("intraday"), S, { seed: { amountUsd: 5_000 } }),
  "gap-fill.txt": () => researchGapFillPrompt("intraday", contextFor("intraday"), { wire: dossier().text }),
  "gap-fill-event.txt": () => researchGapFillPrompt("intraday", contextFor("intraday"), { wire: dossier().text, event: EVENT }),
  "gap-fill-empty-wire.txt": () => researchGapFillPrompt("premarket", contextFor("premarket"), { wire: "" }),
  "event.txt": () => EVENT,
  "wire-dossier.txt": () => dossier().text,
  "decision-system.txt": () => decisionSystemPrompt(S),
  "decision-system-options-off.txt": () => decisionSystemPrompt(OPTIONS_OFF),
  "context.txt": () => renderContext(contextFor("intraday"), S),
  "decision-premarket.txt": () => decisionPrompt("premarket", contextFor("premarket"), { memo: MEMO, error: null }, S),
  "decision-intraday.txt": () => decisionPrompt("intraday", contextFor("intraday"), { memo: MEMO, error: null }, S),
  "decision-close.txt": () => decisionPrompt("close", contextFor("close"), { memo: MEMO, error: null }, S),
  "decision-postmarket.txt": () => decisionPrompt("postmarket", contextFor("postmarket"), { memo: MEMO, error: null }, S),
  "decision-intraday-wire-event.txt": () => decisionPrompt("intraday", contextFor("intraday"), { memo: MEMO, error: null }, S, { wire: dossier().text, event: EVENT, researchSkipped: null }),
  "decision-intraday-research-unavailable.txt": () => decisionPrompt("intraday", contextFor("intraday"), { memo: "", error: "research timed out after 180 s" }, S, { wire: dossier().text }),
  "decision-intraday-research-skipped.txt": () => decisionPrompt("intraday", contextFor("intraday"), { memo: "", error: null }, S, { wire: "", researchSkipped: "no unexplained moves or unconfirmed items, and X was read 12 min ago" }),
  "decision-seed.txt": () => decisionPrompt("intraday", contextFor("intraday"), { memo: MEMO, error: null }, S, { seed: { amountUsd: 5_000 }, wire: dossier().text }),
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

  it("prompt versions, constants and the dossier's lists", () => {
    const d = dossier()
    matchJson("prompts/meta.json", {
      prompt_version: PROMPT_VERSION,
      seed_owner_lean: SEED_OWNER_LEAN,
      seed_stop_pct_default: seedStopPct(S.risk),
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
