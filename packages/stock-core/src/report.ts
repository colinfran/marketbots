import { z } from "zod"
import { OPTION_STRATEGIES } from "./options"

/**
 * The ONE structured shape every AI decision call returns, for every phase of the day
 * (premarket, intraday, close, postmarket). Keeping a single shape means storage, the UI and the
 * execution engine never have to special-case a phase.
 *
 * The schema sent to the model deliberately avoids numeric/array bound keywords (min, max,
 * maxItems...) because providers differ in which JSON-schema keywords they accept. Bounds are
 * described in the field descriptions and enforced afterwards by `normalizeReport`.
 */

export const SENTIMENTS = ["very_bullish", "bullish", "neutral", "bearish", "very_bearish"] as const
export const REGIMES = ["trending_up", "trending_down", "range_bound", "high_volatility", "risk_off", "event_driven"] as const
export const STANCES = ["aggressive", "normal", "defensive", "flat"] as const
export const STOCK_ACTIONS = ["buy", "sell", "adjust_exits", "hold"] as const
export const OPTION_ACTIONS = ["buy_option", "close_option", "hold_option"] as const
export const ACTIONS = [...STOCK_ACTIONS, ...OPTION_ACTIONS] as const
export const HORIZONS = ["intraday", "overnight", "multi_day"] as const
export const SETUPS = ["momentum", "breakout", "pullback", "vwap_reclaim", "mean_reversion", "catalyst", "gap_and_go", "hedge", "other"] as const
export const IMPACTS = ["bullish", "bearish", "mixed", "unknown"] as const
export const SEVERITIES = ["low", "medium", "high"] as const

const ticker = z.string().describe("US-listed ticker in uppercase, e.g. NVDA. No exchange prefix, no $.")
const price = z.number().nullable()

export const optionOrderSchema = z.object({
  strategy: z
    .enum(OPTION_STRATEGIES)
    .describe(
      "long_call / long_put = buy one contract type. call_debit_spread = buy a call and sell a higher-strike call, same expiration. put_debit_spread = buy a put and sell a lower-strike put, same expiration.",
    ),
  long_leg: z.string().describe("Contract to BUY, copied exactly from OPTION CHAINS, e.g. NVDA261120C00140000."),
  short_leg: z
    .string()
    .nullable()
    .describe("Spreads only: the contract to SELL, copied exactly from OPTION CHAINS, same expiration as long_leg. null for long_call / long_put."),
  premium_pct: z.number().nullable().describe("% of account equity to spend on premium (at most OPTIONS.max_premium_per_trade_pct)."),
  stop_loss_pct: z.number().nullable().describe("Exit when the position is worth this % less than was paid, e.g. 50. null = the default."),
  take_profit_pct: z.number().nullable().describe("Take profit when the position is worth this % more than was paid, e.g. 100. null = the default."),
})

export const decisionSchema = z.object({
  symbol: ticker.describe("The stock, or the option's UNDERLYING stock for option actions."),
  action: z
    .enum(ACTIONS)
    .describe(
      "STOCKS: buy = open a NEW position (never add to one). sell = sell some or all of a held position. adjust_exits = replace a held position's stop-loss/take-profit. hold = keep a held position unchanged. OPTIONS: buy_option = open a new options position (needs `option`). close_option = close an open options position (needs structure_id). hold_option = keep it (needs structure_id; may tighten stop_loss/take_profit).",
    ),
  allocation_pct: z.number().nullable().describe("Stock buy only: % of total account equity to commit (e.g. 8 means 8%). null otherwise."),
  sell_pct: z.number().nullable().describe("Stock sell only: % of the currently held shares to sell, 1-100 (100 = close the position). null otherwise."),
  stop_loss: price.describe(
    "Stocks (buy, adjust_exits): stop-loss trigger in dollars, BELOW the current price. Options: the UNDERLYING price that proves the trade wrong (below the current price for calls and call spreads, above it for puts and put spreads); the position is closed when the stock crosses it. null = none.",
  ),
  take_profit: price.describe(
    "Stocks (buy, adjust_exits): take-profit limit in dollars, ABOVE the current price. Options: the UNDERLYING price at which to take profit (above for calls, below for puts). null = none.",
  ),
  horizon: z.enum(HORIZONS).describe("intraday = flat by the close. overnight = may carry to tomorrow. multi_day = swing position (every options position is multi_day)."),
  setup: z.enum(SETUPS),
  conviction: z.number().describe("1-10. Below the minimum in CONTEXT means do not open a trade."),
  rationale: z.string().describe("1-3 sentences: why this, why now. Cite specific numbers from CONTEXT or RESEARCH."),
  evidence: z.array(z.string()).describe("2-5 concrete facts with numbers/times that support the decision."),
  invalidation: z.string().describe("The specific price/event that proves the idea wrong."),
  structure_id: z.string().nullable().describe("close_option / hold_option: the id of the position from OPEN OPTIONS POSITIONS. null otherwise."),
  option: optionOrderSchema.nullable().describe("buy_option only: what to buy, chosen from OPTION CHAINS. null for every other action."),
})

export const botReportSchema = z.object({
  headline: z.string().describe("The single most important takeaway, max ~100 characters."),
  summary: z.string().describe("3-5 sentences in plain English: what is happening in the market and what the bot is doing about it."),
  market: z.object({
    sentiment: z.enum(SENTIMENTS),
    regime: z.enum(REGIMES),
    stance: z.enum(STANCES).describe("How much risk the bot should take right now. flat = stay in cash."),
    confidence: z.number().describe("0-100 confidence in this read of the market."),
    key_drivers: z.array(z.string()).describe("3-6 short bullet drivers with numbers."),
  }),
  catalysts: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().describe("One sentence with the specific numbers/expectations."),
        impact: z.enum(IMPACTS),
        symbols: z.array(ticker),
        time_et: z.string().nullable().describe("Scheduled time today as HH:MM ET, or null if not scheduled."),
        source_url: z.string().nullable(),
      }),
    )
    .describe("0-8 market-moving catalysts relevant today."),
  watchlist: z
    .array(
      z.object({
        symbol: ticker,
        setup: z.enum(SETUPS),
        thesis: z.string().describe("One sentence: why this name is in play today."),
        trigger: z.string().describe("Concrete entry condition, e.g. 'holds above VWAP 412.50 after first pullback with SPY green'."),
        entry_low: price,
        entry_high: price,
        stop_loss: price,
        take_profit: price,
        conviction: z.number().describe("1-10"),
      }),
    )
    .describe("4-12 candidates for the rest of the session (not currently held)."),
  decisions: z
    .array(decisionSchema)
    .describe(
      "Concrete orders for THIS cycle. Must include exactly one decision for every open stock position (hold / adjust_exits / sell) and every open options position (hold_option / close_option). Empty in premarket and postmarket.",
    ),
  risks: z.array(z.object({ risk: z.string(), severity: z.enum(SEVERITIES), mitigation: z.string() })).describe("2-5 risks to the portfolio right now."),
  lessons: z.array(z.string()).describe("Postmarket: 2-5 concrete, reusable lessons from today. Other phases: lessons being applied (may be empty)."),
  next_focus: z.string().describe("What to watch before the next cycle, with levels/times."),
  notification: z.string().describe("Push-notification style summary, max 180 characters."),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).describe("URLs actually used, max 10."),
})

export type BotReport = z.infer<typeof botReportSchema>
export type Decision = z.infer<typeof decisionSchema>
export type OptionOrder = z.infer<typeof optionOrderSchema>
export type Action = (typeof ACTIONS)[number]
export type Horizon = (typeof HORIZONS)[number]

export const isOptionAction = (action: Action) => (OPTION_ACTIONS as readonly string[]).includes(action)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round2 = (value: number) => Math.round(value * 100) / 100
const cleanPrice = (value: number | null) => (value !== null && Number.isFinite(value) && value > 0 ? round2(value) : null)
const cleanPct = (value: number | null, min: number, max: number) => (value !== null && Number.isFinite(value) && value > 0 ? round2(clamp(value, min, max)) : null)
/** "$nvda" / "NASDAQ:NVDA" → "NVDA". */
export const cleanTicker = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/^(NASDAQ|NYSE|AMEX|ARCA):/, "")
/** Contract symbols: uppercase, no spaces or "O:" prefix. */
export const cleanContract = (value: string) => value.trim().toUpperCase().replace(/^O:/, "").replace(/\s+/g, "")
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const isUrl = (value: string | null) => !!value && /^https?:\/\//i.test(value)

/** One decision per stock and per options position: the first one wins. */
const decisionKey = (d: Decision) =>
  d.action === "buy_option" ? `open:${d.symbol}:${d.option?.long_leg ?? ""}` : d.action === "close_option" || d.action === "hold_option" ? `opt:${d.structure_id ?? d.symbol}` : `stock:${d.symbol}`

/** Applies the bounds the schema describes but does not enforce, so stored data is always consistent. */
export const normalizeReport = (report: BotReport, { allowDecisions }: { allowDecisions: boolean }): BotReport => {
  const seen = new Set<string>()
  const decisions = allowDecisions
    ? report.decisions
        .map((d) => ({
          ...d,
          symbol: cleanTicker(d.symbol),
          allocation_pct: d.action === "buy" && d.allocation_pct !== null ? round2(clamp(d.allocation_pct, 0, 100)) : null,
          sell_pct: d.action === "sell" ? round2(clamp(d.sell_pct ?? 100, 1, 100)) : null,
          stop_loss: cleanPrice(d.stop_loss),
          take_profit: cleanPrice(d.take_profit),
          conviction: clamp(Math.round(d.conviction), 1, 10),
          evidence: d.evidence.slice(0, 5),
          structure_id: d.action === "close_option" || d.action === "hold_option" ? (d.structure_id?.trim() || null) : null,
          option:
            d.action === "buy_option" && d.option
              ? {
                  ...d.option,
                  long_leg: cleanContract(d.option.long_leg),
                  short_leg: d.option.short_leg ? cleanContract(d.option.short_leg) : null,
                  premium_pct: cleanPct(d.option.premium_pct, 0.05, 100),
                  stop_loss_pct: cleanPct(d.option.stop_loss_pct, 5, 95),
                  take_profit_pct: cleanPct(d.option.take_profit_pct, 5, 2_000),
                }
              : null,
        }))
        .filter((d) => (seen.has(decisionKey(d)) ? false : (seen.add(decisionKey(d)), true)))
    : []

  return {
    ...report,
    headline: truncate(report.headline.trim(), 140),
    market: {
      ...report.market,
      confidence: clamp(Math.round(report.market.confidence), 0, 100),
      key_drivers: report.market.key_drivers.slice(0, 6),
    },
    catalysts: report.catalysts.slice(0, 8).map((c) => ({
      ...c,
      symbols: c.symbols.map(cleanTicker),
      source_url: isUrl(c.source_url) ? c.source_url : null,
    })),
    watchlist: report.watchlist.slice(0, 12).map((w) => ({
      ...w,
      symbol: cleanTicker(w.symbol),
      entry_low: cleanPrice(w.entry_low),
      entry_high: cleanPrice(w.entry_high),
      stop_loss: cleanPrice(w.stop_loss),
      take_profit: cleanPrice(w.take_profit),
      conviction: clamp(Math.round(w.conviction), 1, 10),
    })),
    decisions,
    risks: report.risks.slice(0, 6),
    lessons: report.lessons.slice(0, 6),
    notification: truncate(report.notification.trim(), 180),
    sources: report.sources.filter((s) => isUrl(s.url)).slice(0, 10),
  }
}
