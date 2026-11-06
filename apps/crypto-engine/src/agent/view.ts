import type { EnvelopeHistory } from "@mb/agent/envelope"
import type { AgentAccount } from "@mb/agent/runtime"
import type { CryptoAgentDeps } from "./book"
import { liveAccount, liveBookText, liveEnvelopeHistory } from "./live"

/** The paper account the crypto agent trades (./live), as the brief, the tools, the observers and the heartbeat read it. */

/** A held position as the observers need it. */
export type Held = { id: string; symbol: string; entry: number; stop: number | null; reviewPrice: number | null; reviewedAt: Date | null }

export const heldPositions = async (d: CryptoAgentDeps): Promise<Held[]> =>
  (await d.ctx.ledger.openPositions()).map((p) => ({ id: p._id, symbol: p.symbol, entry: p.avg_price, stop: p.stop_price, reviewPrice: p.last_review_price, reviewedAt: p.last_reviewed_at }))

/** The envelope's history in the paper account. */
export const envelopeHistory = (d: CryptoAgentDeps, now = Date.now()): Promise<EnvelopeHistory> => liveEnvelopeHistory(d, now)

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = (d: CryptoAgentDeps, now = new Date()) => liveBookText(d, now)

/** The account and today's P&L %, for the heartbeat and the breakers. */
export const agentAccount = (d: CryptoAgentDeps): Promise<AgentAccount | null> => liveAccount(d)
