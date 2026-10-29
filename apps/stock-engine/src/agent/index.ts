import { llamaChat } from "@mb/agent/client"
import { checkEntry } from "@mb/agent/envelope"
import { newsObservations } from "@mb/agent/observations"
import { Agent, type AgentBot } from "@mb/agent/runtime"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { HistoryStore } from "@mb/history/store"
import { stockAgentAnswerSchema, type StockAgentAnswer } from "@mb/stock-core/agent"
import { TICKER_PATTERN } from "@mb/stock-core/settings"
import type { WireCategory, WireItemDoc } from "@mb/stock-core/wire"
import type { Candidate } from "@mb/wire/trigger"
import type { EngineContext } from "../bot/context"
import type { Session } from "../bot/session"
import { actOnStockAnswer } from "./act"
import { createShadowBook, sessionWindow, shadowRiskState, type StockAgentDeps } from "./book"
import { stockBrief, StockObserver } from "./observe"
import { STOCK_AGENT_PROMPT_VERSION, stockAgentSystemPrompt } from "./prompts"
import { stockAgentTools } from "./tools"

/**
 * The stock agent (docs/plans/LOCAL-AI.md §8.7): awake around the clock, buying only in the regular
 * session (outside it, watches, notes and the owner's questions), stocks only (options stay with the
 * timed cycles). The engine feeds it news (the wire policy's observe hook and every stored item, for
 * news watches) and asks it for its status.
 *
 * It may name any ticker it has a price for (the broker's stream or the news engine's price layers,
 * which track the ~1,500-symbol scan universe), or one its book holds.
 */

export type StockAgent = {
  agent: Agent<StockAgentAnswer>
  deps: StockAgentDeps
  onCandidate: (item: WireItemDoc, c: Candidate) => void
  /** One closed minute of the price board's bars, for the setup screen. */
  onBars: (bars: readonly { symbol: string; t: number; close: number; volume: number }[]) => void
}

const MAX_PRICE_AGE_MS = 5 * 60_000

export const createStockAgent = ({
  ctx,
  history,
  calls,
  llmUrl,
  session,
  layerPrice,
}: {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
  calls: Pick<AiCallLog, "record">
  llmUrl: string | null
  session: () => Session | null
  /** The news engine's price layers (a price no older than `maxAgeMs`, or null). */
  layerPrice: (symbol: string, maxAgeMs: number) => number | null
}): StockAgent => {
  const price = (symbol: string) => ctx.prices.fresh(symbol, MAX_PRICE_AGE_MS) ?? layerPrice(symbol, MAX_PRICE_AGE_MS)
  const deps: StockAgentDeps = { ctx, shadow: createShadowBook(ctx), history, session, price }
  let observer: StockObserver | null = null
  const known = (symbol: string) => TICKER_PATTERN.test(symbol) && price(symbol) !== null
  const bot: AgentBot<StockAgentAnswer> = {
    promptVersion: STOCK_AGENT_PROMPT_VERSION,
    system: stockAgentSystemPrompt,
    brief: (wake) => stockBrief(deps, wake),
    tools: stockAgentTools(deps),
    answer: stockAgentAnswerSchema,
    known,
    act: (answer, episode) => actOnStockAnswer(deps, answer, episode, known),
    tick: (now) => observer!.tick(now),
    // Setups are only entry ideas: not worth an episode while a buy can't happen.
    skip: async (wake) => {
      if (!wake.observations.every((o) => o.kind === "setup")) return null
      const window = sessionWindow(deps)
      if (!window.entries) return `no buys now: ${window.reason}`
      const { history } = await shadowRiskState(deps)
      const e = checkEntry("", history, ctx.settings.current.agent.envelope, Date.now())
      return e.approved ? null : `the envelope refuses entries: ${e.reason}`
    },
    shadow: async () => {
      const account = await deps.shadow.account(price)
      return { account, dayPnlPct: account.day_start_equity_usd > 0 ? (account.equity_usd / account.day_start_equity_usd - 1) * 100 : 0 }
    },
  }
  const agent = new Agent<StockAgentAnswer>({
    col: ctx.col,
    bus: ctx.bus,
    log: ctx.log.child({ component: "agent" }),
    settings: () => ctx.settings.current.agent,
    settingsVersion: () => ctx.settings.version,
    chat: llmUrl ? llamaChat(llmUrl) : null,
    calls,
    alert: (title, message, key) => ctx.alerts.send("warning", title, message, { key, path: "/agent" }),
    blocked: () => {
      const st = ctx.state.state
      return st.kill_switch.engaged ? "the kill switch is engaged" : st.status !== "running" ? `trading is ${st.status}` : null
    },
    price,
    bot,
    archive: history,
    signal: ctx.signal,
  })
  observer = new StockObserver(deps, (o) => agent.observe(o), () => agent.lastEpisodeAt?.getTime() ?? 0)
  return {
    agent,
    deps,
    onBars: (bars) => {
      if (agent.on) observer?.bars(bars)
    },
    onCandidate: (item, c) => {
      if (!agent.on) return
      void deps.shadow.open().then((open) => {
        const held = new Set(open.map((p) => p.symbol))
        for (const o of newsObservations(item, c, { held, critical: ctx.settings.current.wire.thresholds.critical })) agent.observe(o)
      })
    },
  }
}
