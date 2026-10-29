import type { EnvelopeHistory } from "@mb/agent/envelope"
import type { AgentAccount } from "@mb/agent/runtime"
import { isLive, shadowBookText, type StockAgentDeps } from "./book"
import { liveAccount, liveBook, liveBookText, liveEnvelopeHistory } from "./live"

/**
 * The book the stock agent decides into, whatever the level: its shadow book, or at level auto the
 * paper account's trading book (./live). The brief, the tools, the observers and the heartbeat read
 * it from here.
 */

/** A held stock as the observers need it. */
export type Held = { id: string; symbol: string; entry: number; stop: number | null; reviewPrice: number | null; reviewedAt: Date | null; horizon: string | null }

export const heldPositions = async (d: StockAgentDeps): Promise<Held[]> => {
  if (!isLive(d)) {
    return (await d.shadow.open()).map((p) => ({ id: p._id, symbol: p.symbol, entry: p.entry_price, stop: p.stop_price, reviewPrice: p.last_review_price, reviewedAt: p.last_reviewed_at, horizon: p.horizon }))
  }
  const book = await liveBook(d)
  return book.stocks.map((p) => {
    const plan = book.plans.get(p.symbol)
    const review = d.reviews.get(p.symbol)
    return { id: p.symbol, symbol: p.symbol, entry: Number(p.avg_entry_price), stop: plan?.stop_loss ?? null, reviewPrice: review?.price ?? null, reviewedAt: review?.at ?? null, horizon: plan?.horizon ?? null }
  })
}

/** Symbols the agent holds in the book it decides into: stocks, and at level auto the underlyings of its options. */
export const heldSymbols = async (d: StockAgentDeps): Promise<Set<string>> => {
  if (!isLive(d)) return new Set((await d.shadow.open()).map((p) => p.symbol))
  const book = await liveBook(d)
  return new Set([...book.stocks.map((p) => p.symbol), ...book.options.map((o) => o.underlying)])
}

/** The envelope's history in the book the agent decides into. */
export const envelopeHistory = async (d: StockAgentDeps, now = Date.now()): Promise<EnvelopeHistory> => {
  if (isLive(d)) return liveEnvelopeHistory(d, Number(d.snapshot()?.account.equity ?? 0), now)
  return d.shadow.envelopeHistory((await d.shadow.account(d.price)).equity_usd)
}

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = (d: StockAgentDeps, now = new Date()) => (isLive(d) ? liveBookText(d, now) : shadowBookText(d, now))

/** The account and today's P&L %, for the heartbeat and the breakers. */
export const agentAccount = async (d: StockAgentDeps): Promise<AgentAccount | null> => {
  if (isLive(d)) return liveAccount(d)
  const account = await d.shadow.account(d.price)
  return { account, dayPnlPct: account.day_start_equity_usd > 0 ? (account.equity_usd / account.day_start_equity_usd - 1) * 100 : 0 }
}
