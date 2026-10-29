import { llamaChat } from "@mb/agent/client"
import { newsObservations } from "@mb/agent/observations"
import { Agent, type AgentBot } from "@mb/agent/runtime"
import { BOOK_SUBJECT, MARKET_SUBJECT } from "@mb/core/agent"
import { cryptoAgentAnswerSchema, type CryptoAgentAnswer } from "@mb/crypto-core/agent"
import type { WireCategory, WireItemDoc } from "@mb/crypto-core/wire"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { HistoryStore } from "@mb/history/store"
import type { Candidate } from "@mb/wire/trigger"
import type { EngineContext } from "../orchestrator/context"
import { actOnCryptoAnswer } from "./act"
import { createShadowBook, mid, type CryptoAgentDeps } from "./book"
import { cryptoBrief, CryptoMarketView, CryptoObserver } from "./observe"
import { CRYPTO_AGENT_PROMPT_VERSION, cryptoAgentSystemPrompt } from "./prompts"
import { cryptoAgentTools } from "./tools"

/**
 * The crypto agent (docs/plans/LOCAL-AI.md §8.7): 24/7, the timed cycles' screens as P1
 * observations, and the shadow book at the paper wallet's fees. The engine feeds it news (the wire
 * policy's observe hook and every stored item, for news watches) and asks it for its status.
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
  llmUrl,
}: {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
  calls: Pick<AiCallLog, "record">
  llmUrl: string | null
}): CryptoAgent => {
  const deps: CryptoAgentDeps = { ctx, shadow: createShadowBook(ctx), history }
  const market = new CryptoMarketView(deps)
  let observer: CryptoObserver | null = null
  const known = (symbol: string) => symbol === MARKET_SUBJECT || symbol === BOOK_SUBJECT || ctx.hub.universe.includes(symbol)
  const bot: AgentBot<CryptoAgentAnswer> = {
    promptVersion: CRYPTO_AGENT_PROMPT_VERSION,
    system: cryptoAgentSystemPrompt,
    brief: (wake) => cryptoBrief(deps, market, wake),
    tools: cryptoAgentTools(deps),
    answer: cryptoAgentAnswerSchema,
    known: (s) => known(s) && s !== MARKET_SUBJECT && s !== BOOK_SUBJECT,
    act: (answer, episode) => actOnCryptoAnswer(deps, answer, episode),
    tick: (now) => observer!.tick(now),
    shadow: async () => {
      const account = await deps.shadow.account(mid(ctx))
      return { account, dayPnlPct: account.day_start_equity_usd > 0 ? (account.equity_usd / account.day_start_equity_usd - 1) * 100 : 0 }
    },
  }
  const agent = new Agent<CryptoAgentAnswer>({
    col: ctx.col,
    bus: ctx.bus,
    log: ctx.log.child({ component: "agent" }),
    settings: () => ctx.settings.current.agent,
    settingsVersion: () => ctx.settings.version,
    chat: llmUrl ? llamaChat(llmUrl) : null,
    calls,
    alert: (title, message, key) => ctx.alerts.send("warning", title, message, { key, path: "/agent" }),
    blocked: () => {
      const g = ctx.gate()
      return g.killSwitch ? "the kill switch is engaged" : g.runStatus !== "running" ? `trading is ${g.runStatus}` : null
    },
    price: mid(ctx),
    bot,
    archive: history,
    signal: ctx.signal,
  })
  observer = new CryptoObserver(deps, market, (o) => agent.observe(o))
  const held = async () => new Set((await deps.shadow.open()).map((p) => p.symbol))
  return {
    agent,
    deps,
    onCandidate: (item, c) => {
      if (!agent.on) return
      void held().then((h) => {
        for (const o of newsObservations(item, c, { held: h, critical: ctx.settings.current.wire.thresholds.critical })) agent.observe(o)
      })
    },
  }
}
