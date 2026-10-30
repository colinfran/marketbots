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
import { STRATEGY_IDS } from "./strategies"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 *
 * The commands both bots accept come from @mb/core/commands; the rest are crypto's own.
 */

export const commandSchema = z.discriminatedUnion("type", [
  pauseCommand,
  resumeCommand,
  killSwitchEngageCommand,
  killSwitchReleaseCommand,
  z.object({ type: z.literal("strategy.set_enabled"), strategy: z.enum(STRATEGY_IDS), enabled: z.boolean() }),
  settingsUpdateCommand,
  z.object({ type: z.literal("position.close"), position_id: z.string().min(1).max(100) }),
  /** Closes everything and restarts the paper wallet at the configured starting capital and fees. */
  z.object({ type: z.literal("paper.reset"), confirm: z.literal("RESET") }),
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
  "strategy.set_enabled": "Toggle strategy",
  "settings.update": base["settings.update"],
  "position.close": "Close position",
  "paper.reset": "Reset paper wallet",
  "wire.replay": base["wire.replay"],
  "agent.ask": base["agent.ask"],
  "agent.review": base["agent.review"],
  "agent.resume_entries": base["agent.resume_entries"],
}
