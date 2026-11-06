import { checkEntry, type EnvelopeHistory } from "@mb/agent/envelope"
import type { AgentAccount, EpisodeInfo } from "@mb/agent/runtime"
import type { AgentAction } from "@mb/core/agent"
import { cleanLine } from "@mb/engine-kit/util/text"
import { normalizeStockAgentDecisions, type StockAgentAnswer, type StockAgentDecision } from "@mb/stock-core/agent"
import type { AlpacaPosition } from "@mb/stock-core/alpaca"
import type { RiskState } from "@mb/stock-core/context"
import type { DecisionDoc, OptionPositionDoc, PositionPlanDoc } from "@mb/stock-core/db"
import { roundTo } from "@mb/stock-core/math"
import { daysToExpiry, describeContract, OPTION_MULTIPLIER, STRATEGY_LABEL } from "@mb/stock-core/options"
import { formatTime, marketDay } from "@mb/stock-core/time"
import { executeDecisions } from "../bot/execute"
import { computeRiskState } from "../bot/risk"
import { limitsText, sessionWindow, type StockAgentDeps } from "./book"

/**
 * The stock agent's decisions into the paper account (docs/plans/LOCAL-AI.md §8.4, §9), stocks and
 * options, through the bot's execution path (`executeDecisions`: the buy rules, the
 * options rules, bracket and OCO orders at the broker, a `decisions` record per decision). Before
 * that, the envelope: an entry must pass its rate limits. A buy's size is code's (risk per trade at
 * its stop, by conviction), an option's premium is capped per position. Buys happen only in the
 * regular session after the opening buffer; sales, exits and holds are never rate-limited.
 *
 * The account comes from the engine's latest snapshot (every 15 s), so reading it costs no broker
 * call; executing refreshes what it needs.
 */

const HOUR = 3_600_000
const LOOKBACK_MS = 7 * 24 * HOUR
const OPEN_OPTIONS = ["opening", "open", "closing"] as const
const TRADES = ["buy", "sell", "buy_option", "close_option"] as const

const ORDER: Record<StockAgentDecision["action"], number> = { sell: 0, close_option: 0, adjust_exits: 1, hold: 2, hold_option: 2, buy: 3, buy_option: 4 }

const action = (d: StockAgentDecision, outcome: AgentAction["outcome"], detail: string | null): AgentAction => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, outcome, detail })

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity"

/** The book's part in the database: the stock positions' plans and the open options positions. */
export const storedBook = async (d: Pick<StockAgentDeps, "ctx">) => {
  const [plans, options] = await Promise.all([d.ctx.col.plans.find().toArray(), d.ctx.col.optionPositions.find({ status: { $in: [...OPEN_OPTIONS] } }).toArray()])
  return { plans: new Map<string, PositionPlanDoc>(plans.map((p) => [p._id, p])), options }
}

export type StoredBook = Awaited<ReturnType<typeof storedBook>>

/** The book: its long stock positions with their plans, and its open options positions. `stored` is a recent read of its database part (the observers'). */
export const liveBook = async (d: Pick<StockAgentDeps, "ctx" | "snapshot">, stored?: StoredBook) => {
  const snap = d.snapshot()
  const { plans, options } = stored ?? (await storedBook(d))
  const stocks = (snap?.positions ?? []).filter((p) => isStock(p) && p.side === "long")
  return { snap, plans, stocks, options }
}

/** What the envelope needs from the paper account: the agent's own entries and actions (its decisions), every stock sale and every stop-out. */
export const liveEnvelopeHistory = async (d: Pick<StockAgentDeps, "ctx">, now = Date.now()): Promise<EnvelopeHistory> => {
  const since = new Date(now - LOOKBACK_MS)
  const [decisions, sales, plans, options] = await Promise.all([
    d.ctx.col.decisions.find({ agent_episode_id: { $exists: true }, status: "executed", created_at: { $gte: since }, action: { $in: [...TRADES] } }, { projection: { symbol: 1, action: 1, created_at: 1 } }).sort({ created_at: 1 }).toArray(),
    d.ctx.col.orders.find({ side: "sell", asset_class: "us_equity", filled_at: { $gte: since } }, { projection: { symbol: 1, filled_at: 1, role: 1 } }).toArray(),
    d.ctx.col.plans.find({}, { projection: { decision_id: 1 } }).toArray(),
    d.ctx.col.optionPositions.find({ status: { $in: [...OPEN_OPTIONS] } }, { projection: { decision_id: 1 } }).toArray(),
  ])
  const opened = [...plans, ...options].map((p) => p.decision_id).filter((id): id is string => !!id)
  const openPositions = opened.length ? await d.ctx.col.decisions.countDocuments({ _id: { $in: opened }, agent_episode_id: { $exists: true } }) : 0
  const lastAction = new Map<string, number>()
  const entries: EnvelopeHistory["entries"] = []
  for (const x of decisions) {
    const at = x.created_at.getTime()
    lastAction.set(x.symbol, at)
    if ((x.action === "buy" || x.action === "buy_option") && now - at < 24 * HOUR) entries.push({ symbol: x.symbol, at })
  }
  const lastExit = new Map<string, number>()
  const lastStopOut = new Map<string, number>()
  for (const o of sales.sort((a, b) => (a.filled_at?.getTime() ?? 0) - (b.filled_at?.getTime() ?? 0))) {
    const at = o.filled_at?.getTime() ?? 0
    lastExit.set(o.symbol, at)
    if (o.role === "stop_loss") lastStopOut.set(o.symbol, at)
  }
  return { openPositions, entries, lastAction, lastExit, lastStopOut }
}

/** The paper account as the risk rules see it, with the envelope's history; null before the engine's first snapshot. */
export const liveRiskState = async (d: Pick<StockAgentDeps, "ctx" | "snapshot">, now = new Date()): Promise<{ risk: RiskState; history: EnvelopeHistory; book: Awaited<ReturnType<typeof liveBook>> } | null> => {
  const book = await liveBook(d)
  if (!book.snap) return null
  const tradesToday = await d.ctx.col.decisions.countDocuments({ trading_day: marketDay(now), status: "executed", action: { $in: [...TRADES] } })
  const risk = computeRiskState(book.snap.account, book.stocks.length, tradesToday, d.ctx.settings.current)
  return { risk, history: await liveEnvelopeHistory(d, now.getTime()), book }
}

/** The paper account, summarized for the heartbeat and the breakers. */
export const liveAccount = (d: Pick<StockAgentDeps, "ctx" | "snapshot">): AgentAccount | null => {
  const snap = d.snapshot()
  if (!snap) return null
  const equity = Number(snap.account.equity)
  const lastEquity = Number(snap.account.last_equity)
  const starting = d.ctx.settings.current.account.starting_capital
  const exposure = snap.positions.reduce((s, p) => s + Number(p.market_value), 0)
  const unrealized = snap.positions.reduce((s, p) => s + Number(p.unrealized_pl ?? 0), 0)
  return {
    account: {
      starting_usd: starting,
      cash_usd: roundTo(Number(snap.account.cash), 2),
      equity_usd: roundTo(equity, 2),
      exposure_usd: roundTo(exposure, 2),
      realized_pnl_usd: roundTo(equity - starting - unrealized, 2),
      unrealized_pnl_usd: roundTo(unrealized, 2),
      return_pct: starting > 0 ? roundTo((equity / starting - 1) * 100, 2) : 0,
      open_positions: snap.positions.length,
      closed_positions: 0,
    },
    dayPnlPct: lastEquity > 0 ? (equity / lastEquity - 1) * 100 : 0,
  }
}

const premiumOf = (o: Pick<OptionPositionDoc, "mark" | "qty" | "cost_usd">) => (o.mark ? o.mark.value * OPTION_MULTIPLIER * o.qty : (o.cost_usd ?? 0))

/** YOUR BOOK and LIMITS for the paper account: the brief's account part, also the `book` tool's answer. */
export const liveBookText = async (d: Pick<StockAgentDeps, "ctx" | "snapshot" | "session" | "price">, now = new Date()) => {
  const state = await liveRiskState(d, now)
  if (!state) return "YOUR BOOK (the paper account): the account isn't loaded yet; ask for the book again in a moment."
  const { risk, history, book } = state
  const settings = d.ctx.settings.current
  const day = marketDay(now)
  const stocks = book.stocks.map((p) => {
    const plan = book.plans.get(p.symbol)
    const m = d.price(p.symbol) ?? Number(p.current_price)
    return `- ${p.symbol}: ${p.qty} shares at ${Number(p.avg_entry_price).toFixed(2)}, now ${m} (${(Number(p.unrealized_plpc ?? 0) * 100).toFixed(2)}%), stop ${plan?.stop_loss ?? "none"}, target ${plan?.take_profit ?? "none"}, ${plan?.horizon ?? "?"} horizon${plan ? `, opened ${formatTime(plan.opened_at)}` : ""}. Thesis: ${plan?.thesis ?? "none recorded"} Invalidation: ${plan?.invalidation ?? "none recorded"}`
  })
  const options = book.options.map(
    (o) =>
      `- options ${o._id}: ${STRATEGY_LABEL[o.strategy]} on ${o.underlying} (${o.legs.map((l) => `${l.side} ${describeContract(l.symbol)}`).join(" / ")}), ${o.qty} contract${o.qty === 1 ? "" : "s"}, paid ${o.entry_price ?? "?"} a share, now ${o.mark?.value ?? "?"} (${o.mark?.pnl_pct ?? "?"}%), ${daysToExpiry(o.expiration, day)} days to expiration, exits -${o.stop_loss_pct}% / +${o.take_profit_pct}%${o.underlying_stop !== null ? `, underlying stop ${o.underlying_stop}` : ""}${o.underlying_target !== null ? `, target ${o.underlying_target}` : ""}. Thesis: ${o.thesis}`,
  )
  const st = d.ctx.state.state
  const window = sessionWindow(d, now)
  const blocked = [st.kill_switch.engaged ? "the kill switch is engaged" : null, st.status !== "running" ? `trading is ${st.status}` : null, window.entries ? null : window.reason, risk.new_buys_allowed ? null : risk.notes.join(" ")].filter(
    (x): x is string => !!x,
  )
  const o = settings.options
  const premium = book.options.reduce((s, x) => s + premiumOf(x), 0)
  const perTrade = risk.profit_lock ? o.max_premium_per_trade_pct / 2 : o.max_premium_per_trade_pct
  const equity = Number(book.snap!.account.equity)
  const lastEquity = Number(book.snap!.account.last_equity)
  const starting = settings.account.starting_capital
  return [
    `YOUR BOOK (the paper account: your decisions trade it; started with $${starting.toLocaleString("en-US")})`,
    `cash $${Number(book.snap!.account.cash).toFixed(2)} · equity $${equity.toFixed(2)} (${starting > 0 ? `${equity >= starting ? "+" : ""}${roundTo((equity / starting - 1) * 100, 2)}%` : "n/a"}) · today ${lastEquity > 0 ? `${equity >= lastEquity ? "+" : ""}${roundTo((equity / lastEquity - 1) * 100, 2)}%` : "n/a"} · ${book.stocks.length} stocks, ${book.options.length} options positions`,
    ...(stocks.length ? stocks : ["- no stock positions"]),
    ...options,
    "",
    ...limitsText(d, { risk, history, blocked }, now),
    `- Options: ${o.enabled ? `open premium $${premium.toFixed(0)} of the ${o.max_total_premium_pct}% of equity cap ($${((equity * o.max_total_premium_pct) / 100).toFixed(0)}); at most ${perTrade}% of equity per position; ${book.options.length}/${o.max_open_positions} positions; conviction ≥ ${o.min_conviction}; long calls and puts${o.allow_spreads ? ", call and put debit spreads" : ""}; buy |delta| ${o.min_delta}-${o.max_delta}, ${o.min_dte}-${o.max_dte} days to expiration; contracts only from an option_menu result in this episode; exits default to -${o.default_stop_loss_pct}% / +${o.default_take_profit_pct}% of the position's value, and code closes positions before expiration` : "disabled"}.`,
    "- Intraday stock positions are closed by code in the last minutes of the session; stops and targets rest at the broker as bracket or OCO orders.",
  ].join("\n")
}

/** What became of a decision `executeDecisions` recorded. */
const outcomeOf = (dec: StockAgentDecision, doc: DecisionDoc | null): AgentAction => {
  if (!doc) return action(dec, "rejected", "not recorded")
  const holding = dec.action === "hold" || dec.action === "hold_option"
  if (doc.status === "executed") return action(dec, dec.action === "adjust_exits" ? "updated" : holding ? "held" : "filled", doc.reason)
  if (doc.status === "noop") return action(dec, holding ? "held" : "rejected", doc.reason)
  return action(dec, "rejected", doc.status === "failed" ? `failed: ${doc.reason ?? ""}` : doc.reason)
}

/** The agent's decisions into the paper account, one at a time (the envelope sees each entry before the next): sales first, exits, holds, then buys by conviction. */
export const actOnStockAnswer = async (
  d: StockAgentDeps,
  answer: StockAgentAnswer,
  episode: Pick<EpisodeInfo, "id" | "wake" | "entriesPaused">,
  known: (symbol: string) => boolean,
): Promise<AgentAction[]> => {
  const { ctx } = d
  const settings = ctx.settings.current
  const book = await liveBook(d)
  const held = new Set([...book.stocks.map((p) => p.symbol), ...book.options.map((o) => o.underlying)])
  const { decisions, dropped } = normalizeStockAgentDecisions(answer.decisions, { known: (s) => held.has(s) || known(s) })
  const out: AgentAction[] = dropped.map((why) => ({ symbol: why.split(":")[0], action: "unknown", conviction: 0, outcome: "rejected", detail: why }))
  const window = sessionWindow(d)
  const chains = d.offered.get(episode.id) ?? new Map()
  const itemIds = [...new Set(episode.wake.observations.flatMap((o) => o.refs.item_ids ?? []))]
  const entriesBlocked = () => {
    const st = ctx.state.state
    return st.kill_switch.engaged ? `kill switch engaged: ${st.kill_switch.reason ?? "no reason given"}` : st.status !== "running" ? `trading is ${st.status}` : null
  }
  try {
    for (const dec of [...decisions].sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.conviction - a.conviction)) {
      let decision = dec
      if (dec.action === "buy" || dec.action === "buy_option") {
        if (episode.entriesPaused) {
          out.push(action(dec, "blocked", episode.entriesPaused))
          continue
        }
        if (!window.entries) {
          out.push(action(dec, "blocked", `buys only in the regular session after the opening buffer (now: ${window.reason})`))
          continue
        }
        const state = await liveRiskState(d)
        if (!state) {
          out.push(action(dec, "rejected", "the account isn't loaded yet"))
          continue
        }
        const envelope = checkEntry(dec.symbol, state.history, settings.agent.envelope, Date.now())
        if (!envelope.approved) {
          out.push(action(dec, "blocked", `envelope: ${envelope.reason}`))
          continue
        }
        // Code sizes a buy from its stop and conviction (no allocation); an option's premium stays within the per-position cap.
        if (dec.action === "buy") decision = { ...dec, allocation_pct: null }
        else if (dec.option) {
          const perTrade = state.risk.profit_lock ? settings.options.max_premium_per_trade_pct / 2 : settings.options.max_premium_per_trade_pct
          decision = { ...dec, option: { ...dec.option, premium_pct: roundTo(Math.min(dec.option.premium_pct ?? perTrade, perTrade), 2) } }
        }
      }
      const started = new Date()
      await executeDecisions(ctx, {
        cycleId: episode.id,
        reportId: episode.id,
        phase: window.closing ? "close" : "intraday",
        report: { decisions: [decision] },
        chains,
        entriesBlocked,
        triggerKind: "agent",
        wireItemIds: itemIds.length ? { "*": itemIds } : undefined,
        holdUnmentioned: false,
        agentEpisodeId: episode.id,
      })
      const doc = await ctx.col.decisions.findOne({ cycle_id: episode.id, symbol: dec.symbol, action: dec.action, created_at: { $gte: started } }, { sort: { created_at: -1 } })
      const result = outcomeOf(dec, doc)
      out.push(result)
      // The price at its decision on a held stock: the next price-move wake-up counts from it.
      const p = d.price(dec.symbol)
      if (p !== null && (dec.action === "hold" || dec.action === "adjust_exits" || dec.action === "sell")) d.reviews.set(dec.symbol, { price: p, at: new Date() })
      // Buys already post to Discord when they fill; the agent's exits say so here.
      if (result.outcome === "filled" && (dec.action === "sell" || dec.action === "close_option")) {
        await ctx.alerts
          .success(`Agent sold ${dec.symbol}${dec.action === "close_option" ? " options" : ""}`, `[paper] ${cleanLine(dec.rationale, 400)}`, { path: `/agent/${episode.id}`, key: `agent-exit|${doc?._id ?? episode.id}`, fields: { Detail: result.detail } })
          .catch(() => undefined)
      }
    }
  } finally {
    d.offered.delete(episode.id)
  }
  return out
}
