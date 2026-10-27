import { z } from "zod"
import { PHASES, TICKER_PATTERN } from "./settings"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 */

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause"), reason: z.string().max(200).optional() }),
  z.object({ type: z.literal("resume") }),
  z.object({
    type: z.literal("kill_switch.engage"),
    reason: z.string().min(1).max(200),
    /** Also close every position at market. Off by default: halting is usually enough. */
    liquidate: z.boolean(),
  }),
  z.object({ type: z.literal("kill_switch.release"), confirm: z.literal("RELEASE") }),
  z.object({
    type: z.literal("settings.update"),
    /** Deep partial of Settings; validated against the full schema after merging. */
    patch: z.record(z.string(), z.unknown()),
    /** Optimistic concurrency: rejected if settings changed since the form was loaded. */
    expected_version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("cycle.run_now"),
    /** Force a phase; by default the schedule decides (intraday while the market is open). */
    phase: z.enum(PHASES).optional(),
    /** Tickers to put in front of the AI this cycle (as stock or options ideas). */
    symbols: z.array(z.string().regex(TICKER_PATTERN)).max(5).optional(),
  }),
  z.object({ type: z.literal("position.close"), symbol: z.string().regex(TICKER_PATTERN) }),
  z.object({ type: z.literal("option.close"), structure_id: z.string().min(1).max(100) }),
  /** Re-reads orders, fills, positions and the account from Alpaca right away. */
  z.object({ type: z.literal("broker.sync") }),
  /**
   * One-time seed buy: at `at` (in the regular session), research and an AI allocation put about
   * `amount_usd` into long-term core holdings. The engine refuses it once a seed has completed,
   * unless `force` is set.
   */
  z.object({
    type: z.literal("seed.schedule"),
    amount_usd: z.number().min(100).max(10_000),
    at: z.iso.datetime({ offset: true }),
    force: z.boolean().optional(),
  }),
  z.object({ type: z.literal("seed.cancel") }),
  /** Runs a stored news item through the trigger policy and reports what it would do. Never starts a cycle. */
  z.object({ type: z.literal("wire.replay"), item_id: z.string().min(8).max(64) }),
])

export type Command = z.infer<typeof commandSchema>
export type CommandType = Command["type"]

export const COMMAND_LABEL: Record<CommandType, string> = {
  pause: "Pause trading",
  resume: "Resume trading",
  "kill_switch.engage": "Engage kill switch",
  "kill_switch.release": "Release kill switch",
  "settings.update": "Update settings",
  "cycle.run_now": "Run cycle now",
  "position.close": "Close stock position",
  "option.close": "Close options position",
  "broker.sync": "Sync with Alpaca",
  "seed.schedule": "Schedule seed buy",
  "seed.cancel": "Cancel seed buy",
  "wire.replay": "Replay news item",
}
