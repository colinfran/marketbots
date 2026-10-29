import {
  agentAskCommand,
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
import { PHASES, TICKER_PATTERN } from "./settings"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 *
 * The commands both bots accept come from @mb/core/commands; the rest are stock's own. A seed
 * buy runs in the regular session.
 */

export const commandSchema = z.discriminatedUnion("type", [
  pauseCommand,
  resumeCommand,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  settingsUpdateCommand,
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
  seedScheduleCommand,
  seedCancelCommand,
  wireReplayCommand,
  agentAskCommand,
  /**
   * Runs the core book's weekly review now (it then counts as this week's). A dry run plans the
   * trades without placing them, and works while the core book is off, so its first review can be
   * previewed.
   */
  z.object({ type: z.literal("core.review"), dry_run: z.boolean().optional() }),
])

export type Command = z.infer<typeof commandSchema>
export type CommandType = Command["type"]

const base = BASE_COMMAND_LABEL

export const COMMAND_LABEL: Record<CommandType, string> = {
  pause: base.pause,
  resume: base.resume,
  "kill_switch.engage": base["kill_switch.engage"],
  "kill_switch.release": base["kill_switch.release"],
  "settings.update": base["settings.update"],
  "cycle.run_now": "Run cycle now",
  "position.close": "Close stock position",
  "option.close": "Close options position",
  "broker.sync": "Sync with Alpaca",
  "seed.schedule": base["seed.schedule"],
  "seed.cancel": base["seed.cancel"],
  "wire.replay": base["wire.replay"],
  "agent.ask": base["agent.ask"],
  "core.review": "Run core review",
}
