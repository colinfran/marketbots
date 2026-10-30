import { llamaChat } from "@mb/agent/client"
import { checkEntry } from "@mb/agent/envelope"
import { newsObservations } from "@mb/agent/observations"
import { Agent, type AgentBot, type Pause, type Promotion } from "@mb/agent/runtime"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { HistoryStore } from "@mb/history/store"
import { stockAgentAnswerSchema, type StockAgentAnswer } from "@mb/stock-core/agent"
import type { EventDataMap } from "@mb/stock-core/events"
import { TICKER_PATTERN } from "@mb/stock-core/settings"
import type { WireCategory, WireItemDoc } from "@mb/stock-core/wire"
import type { Candidate } from "@mb/wire/trigger"
import type { EngineContext } from "../bot/context"
import type { Session } from "../bot/session"
import { sessionWindow, type StockAgentDeps } from "./book"
import { actOnStockAnswer } from "./live"
import { stockBrief, StockObserver } from "./observe"
import { STOCK_AGENT_PROMPT_VERSION, stockAgentSystemPrompt } from "./prompts"
import { stockAgentTools } from "./tools"
import { agentAccount, envelopeHistory, heldSymbols } from "./view"

/**
 * The stock agent (docs/plans/LOCAL-AI.md §8.7): awake around the clock, buying only in the regular
 * session (outside it, watches, notes and the owner's questions). It trades the paper account,
 * stocks and options. The engine feeds it
 * news (the wire policy's observe hook and every stored item, for news watches), the price board's
 * closed minutes (the setup screen), the positions the broker closes at their stops and targets,
 * and asks it for its status.
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
  snapshot,
  busy,
  pause,
  promotion,
}: {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
  calls: Pick<AiCallLog, "record">
  llmUrl: string | null
  session: () => Session | null
  /** The news engine's price layers (a price no older than `maxAgeMs`, or null). */
  layerPrice: (symbol: string, maxAgeMs: number) => number | null
  /** The broker's account and positions as the engine last read them. */
  snapshot: StockAgentDeps["snapshot"]
  /** Why the engine wants no episode to act now (its cycle slot is running a seed or a core review), or null. */
  busy?: () => string | null
  /** A breaker's pause on new entries, kept in the engine's state. */
  pause?: { get: () => Pause | null; set: (p: Pause | null, by: string) => Promise<void> }
  /** When the agent was last turned on or its entries resumed, kept in the engine's state. */
  promotion?: { get: () => Promotion | null; set: (p: Promotion) => Promise<void> }
}): StockAgent => {
  const price = (symbol: string) => ctx.prices.fresh(symbol, MAX_PRICE_AGE_MS) ?? layerPrice(symbol, MAX_PRICE_AGE_MS)
  const deps: StockAgentDeps = { ctx, history, session, price, snapshot, offered: new Map(), reviews: new Map() }
  let observer: StockObserver | null = null
  const known = (symbol: string) => TICKER_PATTERN.test(symbol) && price(symbol) !== null
  const bot: AgentBot<StockAgentAnswer> = {
    promptVersion: STOCK_AGENT_PROMPT_VERSION,
    system: () => stockAgentSystemPrompt(),
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
      const e = checkEntry("", await envelopeHistory(deps), ctx.settings.current.agent.envelope, Date.now())
      return e.approved ? null : `the envelope refuses entries: ${e.reason}`
    },
    account: () => agentAccount(deps),
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
      return st.kill_switch.engaged ? "the kill switch is engaged" : st.status !== "running" ? `trading is ${st.status}` : (busy?.() ?? null)
    },
    price,
    bot,
    archive: history,
    pause,
    promotion,
    signal: ctx.signal,
  })
  observer = new StockObserver(deps, (o) => agent.observe(o), () => agent.lastEpisodeAt?.getTime() ?? 0)
  // A stop or target the broker fills is the agent's to look at.
  ctx.bus.subscribe((e) => {
    if (e.type !== "position.closed" || !agent.on) return
    const data = e.data as EventDataMap["position.closed"]
    if (data.asset_class === "us_equity") observer?.onPositionClosed(data)
  })
  return {
    agent,
    deps,
    onBars: (bars) => {
      if (agent.on) observer?.bars(bars)
    },
    onCandidate: (item, c) => {
      if (!agent.on) return
      void heldSymbols(deps).then((held) => {
        for (const o of newsObservations(item, c, { held, critical: ctx.settings.current.wire.thresholds.critical })) agent.observe(o)
      })
    },
  }
}
