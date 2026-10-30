import {
  agentAskCommand,
  agentResumeEntriesCommand,
  agentReviewCommand,
  BASE_COMMAND_LABEL,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  pauseCommand,
  resumeCommand,
  settingsUpdateCommand,
  wireReplayCommand,
} from "@mb/core/commands"
import { z } from "zod"
import { TICKER_PATTERN } from "./settings"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 *
 * The commands both bots accept come from @mb/core/commands; the rest are stock's own.
 */

export const commandSchema = z.discriminatedUnion("type", [
  pauseCommand,
  resumeCommand,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  settingsUpdateCommand,
  z.object({ type: z.literal("position.close"), symbol: z.string().regex(TICKER_PATTERN) }),
  z.object({ type: z.literal("option.close"), structure_id: z.string().min(1).max(100) }),
  /** Re-reads orders, fills, positions and the account from Alpaca right away. */
  z.object({ type: z.literal("broker.sync") }),
  wireReplayCommand,
  agentAskCommand,
  agentReviewCommand,
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
  "settings.update": base["settings.update"],
  "position.close": "Close stock position",
  "option.close": "Close options position",
  "broker.sync": "Sync with Alpaca",
  "wire.replay": base["wire.replay"],
  "agent.ask": base["agent.ask"],
  "agent.review": base["agent.review"],
  "agent.resume_entries": base["agent.resume_entries"],
}
