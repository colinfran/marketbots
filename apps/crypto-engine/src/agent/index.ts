import { llamaChat } from "@mb/agent/client"
import { checkEntry } from "@mb/agent/envelope"
import { newsObservations } from "@mb/agent/observations"
import { Agent, type AgentBot, type Pause, type Promotion } from "@mb/agent/runtime"
import { BOOK_SUBJECT, MARKET_SUBJECT } from "@mb/core/agent"
import { cryptoAgentAnswerSchema, type CryptoAgentAnswer } from "@mb/crypto-core/agent"
import type { EventDataMap } from "@mb/crypto-core/events"
import type { WireCategory, WireItemDoc } from "@mb/crypto-core/wire"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { ModelCalls } from "@mb/engine-kit/ai/monitor"
import type { HistoryStore } from "@mb/history/store"
import type { Candidate } from "@mb/wire/trigger"
import type { EngineContext } from "../orchestrator/context"
import type { CryptoAgentDeps } from "./book"
import { actOnCryptoAnswer } from "./live"
import { cryptoBrief, CryptoMarketView, CryptoObserver } from "./observe"
import { CRYPTO_AGENT_PROMPT_VERSION, cryptoAgentSystemPrompt } from "./prompts"
import { cryptoAgentTools } from "./tools"
import { agentAccount, envelopeHistory, heldPositions } from "./view"

/**
 * The crypto agent (docs/plans/LOCAL-AI.md §8.7): 24/7, the screens' setups as P1 observations, and
 * the paper account as its book. The engine feeds it news (the wire policy's observe hook and every
 * stored item, for news watches), the positions its protection loop closes, and asks it for its
 * status.
 */

export type CryptoAgent = {
  agent: Agent<CryptoAgentAnswer>
  deps: CryptoAgentDeps
  /** A news trigger candidate that passed the item's own gates. */
  onCandidate: (item: WireItemDoc, c: Candidate) => void
}

export const createCryptoAgent = ({
  ctx,
  history,
  calls,
  models,
  llmUrl,
  pause,
  promotion,
}: {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
  calls: Pick<AiCallLog, "record">
  /** The live model feed: each step streams there. */
  models?: ModelCalls
  llmUrl: string | null
  /** A breaker's pause on new entries, kept in the engine's state. */
  pause?: { get: () => Pause | null; set: (p: Pause | null, by: string) => Promise<void> }
  /** When the agent was last turned on or its entries resumed, kept in the engine's state. */
  promotion?: { get: () => Promotion | null; set: (p: Promotion) => Promise<void> }
}): CryptoAgent => {
  const deps: CryptoAgentDeps = { ctx, history }
  const market = new CryptoMarketView(deps)
  let observer: CryptoObserver | null = null
  const known = (symbol: string) => symbol === MARKET_SUBJECT || symbol === BOOK_SUBJECT || ctx.hub.universe.includes(symbol)
  const bot: AgentBot<CryptoAgentAnswer> = {
    promptVersion: CRYPTO_AGENT_PROMPT_VERSION,
    system: () => cryptoAgentSystemPrompt(),
    brief: (wake) => cryptoBrief(deps, market, wake),
    tools: cryptoAgentTools(deps),
    answer: cryptoAgentAnswerSchema,
    known: (s) => known(s) && s !== MARKET_SUBJECT && s !== BOOK_SUBJECT,
    act: (answer, episode) => actOnCryptoAnswer(deps, answer, episode),
    tick: (now) => observer!.tick(now),
    // A setup is only an entry idea: not worth an episode while entries are refused.
    skip: async (wake) => {
      if (!wake.observations.every((o) => o.kind === "setup")) return null
      if ((await heldPositions(deps)).some((p) => p.symbol === wake.subject)) return null
      const gate = ctx.gate()
      if (!gate.venueOnline) return "Kraken data or the paper wallet is unavailable"
      if (!gate.reconciled) return "the books don't match the paper wallet yet"
      const e = checkEntry(wake.subject, await envelopeHistory(deps), ctx.settings.current.agent.envelope, Date.now())
      return e.approved ? null : `the envelope refuses entries: ${e.reason}`
    },
    account: () => agentAccount(deps),
  }
  const agent = new Agent<CryptoAgentAnswer>({
    col: ctx.col,
    bus: ctx.bus,
    log: ctx.log.child({ component: "agent" }),
    settings: () => ctx.settings.current.agent,
    settingsVersion: () => ctx.settings.version,
    chat: llmUrl ? llamaChat(llmUrl) : null,
    models,
    calls,
    alert: (title, message, key) => ctx.alerts.send("warning", title, message, { key, path: "/agent" }),
    blocked: () => {
      const g = ctx.gate()
      return g.killSwitch ? "the kill switch is engaged" : g.runStatus !== "running" ? `trading is ${g.runStatus}` : null
    },
    price: (symbol) => ctx.hub.quote(symbol)?.mid ?? null,
    bot,
    archive: history,
    pause,
    promotion,
    signal: ctx.signal,
  })
  observer = new CryptoObserver(deps, market, (o) => agent.observe(o), () => agent.lastEpisodeAt?.getTime() ?? 0)
  ctx.hub.onBar((bar) => observer?.onBar(bar))
  // A stop or target the engine's protection loop hits is the agent's to look at.
  ctx.bus.subscribe((e) => {
    if (e.type === "position.closed" && agent.on) observer?.onPositionClosed(e.data as EventDataMap["position.closed"])
  })
  return {
    agent,
    deps,
    onCandidate: (item, c) => {
      if (!agent.on) return
      void heldPositions(deps).then((open) => {
        const held = new Set(open.map((p) => p.symbol))
        for (const o of newsObservations(item, c, { held, critical: ctx.settings.current.wire.thresholds.critical })) agent.observe(o)
      })
    },
  }
}
