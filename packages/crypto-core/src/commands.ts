import {
  agentAskCommand,
  agentResumeEntriesCommand,
  BASE_COMMAND_LABEL,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  pauseCommand,
  resumeCommand,
  seedCancelCommand,
  seedScheduleCommand,
  settingsUpdateCommand,
  wireReplayCommand,
} from "@mb/core/commands"
import { z } from "zod"
import { STRATEGY_IDS, type StrategyId } from "./strategies"
import { SYMBOL_PATTERN } from "./venues"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 *
 * The commands both bots accept come from @mb/core/commands; the rest are crypto's own.
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
  pauseCommand,
  resumeCommand,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  z.object({ type: z.literal("strategy.set_enabled"), strategy: z.enum(STRATEGY_IDS), enabled: z.boolean() }),
  settingsUpdateCommand,
  z.object({
    type: z.literal("cycle.run_now"),
    /** Pairs to put in front of the AI this cycle even if no screen flagged them. */
    symbols: z.array(z.string().regex(SYMBOL_PATTERN)).max(5).optional(),
  }),
  z.object({ type: z.literal("position.close"), position_id: z.string().min(1).max(100) }),
  /** Closes everything and restarts the paper wallet at the configured starting capital and fees. */
  z.object({ type: z.literal("paper.reset"), confirm: z.literal("RESET") }),
  z.object({ type: z.literal("backtest.run"), params: backtestParamsSchema }),
  seedScheduleCommand,
  seedCancelCommand,
  wireReplayCommand,
  agentAskCommand,
  agentResumeEntriesCommand,
])

export type Command = z.infer<typeof commandSchema>
export type CommandType = Command["type"]

const base = BASE_COMMAND_LABEL

export const COMMAND_LABEL: Record<CommandType, string> = {
  pause: base.pause,
  resume: base.resume,
  "kill_switch.engage": base["kill_switch.engage"],
  "kill_switch.release": base["kill_switch.release"],
  "strategy.set_enabled": "Toggle strategy",
  "settings.update": base["settings.update"],
  "cycle.run_now": "Run cycle now",
  "position.close": "Close position",
  "paper.reset": "Reset paper wallet",
  "backtest.run": "Run backtest",
  "seed.schedule": base["seed.schedule"],
  "seed.cancel": base["seed.cancel"],
  "wire.replay": base["wire.replay"],
  "agent.ask": base["agent.ask"],
  "agent.resume_entries": base["agent.resume_entries"],
}
