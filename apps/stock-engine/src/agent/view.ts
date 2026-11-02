import type { EnvelopeHistory } from "@mb/agent/envelope"
import type { AgentAccount } from "@mb/agent/runtime"
import type { StockAgentDeps } from "./book"
import { liveAccount, liveBook, liveBookText, liveEnvelopeHistory, type StoredBook } from "./live"

/** The paper account's trading book the stock agent trades (./live), as the brief, the tools, the observers and the heartbeat read it. */

/** A held stock as the observers need it. */
export type Held = { id: string; symbol: string; entry: number; stop: number | null; reviewPrice: number | null; reviewedAt: Date | null; horizon: string | null }

export const heldPositions = async (d: StockAgentDeps, stored?: StoredBook): Promise<Held[]> => {
  const book = await liveBook(d, stored)
  return book.stocks.map((p) => {
    const plan = book.plans.get(p.symbol)
    const review = d.reviews.get(p.symbol)
    return { id: p.symbol, symbol: p.symbol, entry: Number(p.avg_entry_price), stop: plan?.stop_loss ?? null, reviewPrice: review?.price ?? null, reviewedAt: review?.at ?? null, horizon: plan?.horizon ?? null }
  })
}

/** Symbols the agent holds: stocks, and the underlyings of its options. */
export const heldSymbols = async (d: StockAgentDeps, stored?: StoredBook): Promise<Set<string>> => {
  const book = await liveBook(d, stored)
  return new Set([...book.stocks.map((p) => p.symbol), ...book.options.map((o) => o.underlying)])
}

/** The envelope's history in the paper account. */
export const envelopeHistory = async (d: StockAgentDeps, now = Date.now()): Promise<EnvelopeHistory> => liveEnvelopeHistory(d, Number(d.snapshot()?.account.equity ?? 0), now)

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = (d: StockAgentDeps, now = new Date()) => liveBookText(d, now)

/** The account and today's P&L %, for the heartbeat and the breakers. */
export const agentAccount = async (d: StockAgentDeps): Promise<AgentAccount | null> => liveAccount(d)
