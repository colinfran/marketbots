import type { AgentSettings } from "@mb/core/settings"

/**
 * The agent envelope (docs/plans/LOCAL-AI.md §9, ring 3): limits on what the agent does, tighter
 * than the bot's own risk caps. Thinking is free; acting is rationed. Pure functions, like the
 * risk engines: same inputs, same answer, every check returned for the audit trail.
 *
 * Entries are rate-limited and sized down; risk-reducing actions (close, reduce, a tighter stop)
 * are never blocked by the envelope's rate limits. Windows are rolling (the last hour, the last
 * 24 hours), the same in both bots.
 */

export type Envelope = AgentSettings["envelope"]

export type EnvelopeCheck = { name: string; ok: boolean; detail: string }

/** What the envelope needs to know about the agent's recent activity (the shadow book's fills). */
export type EnvelopeHistory = {
  equityUsd: number
  openPositions: number
  /** Every entry in the last 24 hours. */
  entries: { symbol: string; at: number; notionalUsd: number }[]
  /** The last entry, exit or reduction per symbol (stop tightening doesn't count). */
  lastAction: ReadonlyMap<string, number>
  /** The last exit per symbol, and the last stop-out. */
  lastExit: ReadonlyMap<string, number>
  lastStopOut: ReadonlyMap<string, number>
}

const HOUR = 3_600_000

const minutesAgo = (now: number, at: number) => Math.round((now - at) / 60_000)

/** Every rule a new agent entry must pass, in order. The first failure is the reason. */
export const checkEntry = (symbol: string, h: EnvelopeHistory, e: Envelope, now: number): { approved: boolean; checks: EnvelopeCheck[]; reason: string | null } => {
  const checks: EnvelopeCheck[] = []
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const lastHour = h.entries.filter((x) => now - x.at < HOUR).length
  const lastDay = h.entries.filter((x) => now - x.at < 24 * HOUR).length
  check("agent entries per day", lastDay < e.entries_per_day, `${lastDay}/${e.entries_per_day} in the last 24 h`)
  check("agent entries per hour", lastHour < e.entries_per_hour, `${lastHour}/${e.entries_per_hour} in the last hour`)
  check("agent open positions", h.openPositions < e.max_open_positions, `${h.openPositions}/${e.max_open_positions} open`)
  const last = h.lastAction.get(symbol)
  check("one action per symbol", last === undefined || now - last >= e.symbol_action_minutes * 60_000, last === undefined ? "no recent action" : `last action ${minutesAgo(now, last)} min ago (min ${e.symbol_action_minutes})`)
  const stop = h.lastStopOut.get(symbol)
  check("no re-entry after a stop-out", stop === undefined || now - stop >= e.reentry_after_stop_hours * HOUR, stop === undefined ? "no recent stop-out" : `stopped out ${minutesAgo(now, stop)} min ago (wait ${e.reentry_after_stop_hours} h)`)
  const exit = h.lastExit.get(symbol)
  check("no flips", exit === undefined || now - exit >= e.flip_hours * HOUR, exit === undefined ? "no recent exit" : `exited ${minutesAgo(now, exit)} min ago (wait ${e.flip_hours} h)`)
  const failed = checks.find((c) => !c.ok)
  return { approved: !failed, checks, reason: failed?.detail ?? null }
}

/**
 * The most an agent entry may commit now, in $: its share of what the risk checks allowed, and
 * whatever is left of the hour's commitment budget. 0 means no room.
 */
export const entryRoomUsd = (riskAllowedUsd: number, h: EnvelopeHistory, e: Envelope, now: number) => {
  const committed = h.entries.filter((x) => now - x.at < HOUR).reduce((s, x) => s + x.notionalUsd, 0)
  const hourRoom = Math.max(0, (h.equityUsd * e.commit_per_hour_pct) / 100 - committed)
  return Math.max(0, Math.min((riskAllowedUsd * e.size_pct) / 100, hourRoom))
}
