import { z } from "zod"
import { STRATEGY_IDS, type StrategyId } from "./strategies"
import { SYMBOL_PATTERN } from "./venues"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 */

export const BACKTEST_INTERVALS = [60, 240, 1440] as const

/**
 * Strategies the backtester can replay. Event-driven and on-demand need research at decision time
 * (look-ahead), and long-term trend's multi-week holds don't fit the backtest's 72h time stop.
 */
export const BACKTEST_STRATEGIES = ["trend", "mean_reversion", "momentum"] as const satisfies readonly StrategyId[]

export const backtestParamsSchema = z.object({
  symbols: z.array(z.string().regex(SYMBOL_PATTERN)).min(1).max(10),
  strategies: z.array(z.enum(BACKTEST_STRATEGIES)).min(1),
  interval: z.union([z.literal(60), z.literal(240), z.literal(1440)]),
  starting_usd: z.number().min(100).max(10_000_000),
  /** Extra adverse slippage on every fill, on top of the modeled spread. */
  slippage_bps: z.number().min(0).max(200),
  fee_bps: z.number().min(0).max(200),
  /** Fraction of history used as in-sample; the rest is reported separately as out-of-sample. */
  in_sample_fraction: z.number().min(0.3).max(0.9),
})
export type BacktestParams = z.infer<typeof backtestParamsSchema>

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
  z.object({ type: z.literal("strategy.set_enabled"), strategy: z.enum(STRATEGY_IDS), enabled: z.boolean() }),
  z.object({
    type: z.literal("settings.update"),
    /** Deep partial of Settings; validated against the full schema after merging. */
    patch: z.record(z.string(), z.unknown()),
    /** Optimistic concurrency: rejected if settings changed since the form was loaded. */
    expected_version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("cycle.run_now"),
    /** Pairs to put in front of the AI this cycle even if no screen flagged them. */
    symbols: z.array(z.string().regex(SYMBOL_PATTERN)).max(5).optional(),
  }),
  z.object({ type: z.literal("position.close"), position_id: z.string().min(1).max(100) }),
  /** Closes everything and restarts the paper wallet at the configured starting capital and fees. */
  z.object({ type: z.literal("paper.reset"), confirm: z.literal("RESET") }),
  z.object({ type: z.literal("backtest.run"), params: backtestParamsSchema }),
  /**
   * One-time seed buy: at `at`, research and an AI allocation put about `amount_usd` into long-term
   * core holdings. The engine refuses it once a seed has completed, unless `force` is set.
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
  "strategy.set_enabled": "Toggle strategy",
  "settings.update": "Update settings",
  "cycle.run_now": "Run cycle now",
  "position.close": "Close position",
  "paper.reset": "Reset paper wallet",
  "backtest.run": "Run backtest",
  "seed.schedule": "Schedule seed buy",
  "seed.cancel": "Cancel seed buy",
  "wire.replay": "Replay news item",
}
