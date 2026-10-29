import type { EnvelopeHistory } from "@mb/agent/envelope"
import type { AgentAccount } from "@mb/agent/runtime"
import { isLive, mid, shadowBookText, type CryptoAgentDeps } from "./book"
import { liveAccount, liveBookText, liveEnvelopeHistory } from "./live"

/**
 * The book the crypto agent decides into, whatever the level: its shadow book, or at level auto the
 * paper account (./live). The brief, the tools, the observers and the heartbeat read it from here.
 */

/** A held position as the observers need it. */
export type Held = { id: string; symbol: string; entry: number; stop: number | null; reviewPrice: number | null; reviewedAt: Date | null }

export const heldPositions = async (d: CryptoAgentDeps): Promise<Held[]> =>
  isLive(d)
    ? (await d.ctx.ledger.openPositions()).map((p) => ({ id: p._id, symbol: p.symbol, entry: p.avg_price, stop: p.stop_price, reviewPrice: p.last_review_price, reviewedAt: p.last_reviewed_at }))
    : (await d.shadow.open()).map((p) => ({ id: p._id, symbol: p.symbol, entry: p.entry_price, stop: p.stop_price, reviewPrice: p.last_review_price, reviewedAt: p.last_reviewed_at }))

/** The envelope's history in the book the agent decides into. */
export const envelopeHistory = async (d: CryptoAgentDeps, now = Date.now()): Promise<EnvelopeHistory> => {
  if (isLive(d)) return liveEnvelopeHistory(d, (await d.ctx.ledger.account())?.equity_usd ?? 0, now)
  return d.shadow.envelopeHistory((await d.shadow.account(mid(d.ctx))).equity_usd)
}

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = (d: CryptoAgentDeps, now = new Date()) => (isLive(d) ? liveBookText(d, now) : shadowBookText(d, now))

/** The account and today's P&L %, for the heartbeat and the breakers. */
export const agentAccount = async (d: CryptoAgentDeps): Promise<AgentAccount | null> => {
  if (isLive(d)) return liveAccount(d)
  const account = await d.shadow.account(mid(d.ctx))
  return { account, dayPnlPct: account.day_start_equity_usd > 0 ? (account.equity_usd / account.day_start_equity_usd - 1) * 100 : 0 }
}
