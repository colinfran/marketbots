import { z } from "zod"

/**
 * Dashboard → engine commands. The web app validates a command, writes it to the `commands`
 * collection and records an audit entry; the engine polls the collection, validates again, applies
 * it and writes back the result. Going through MongoDB means every control action is durable and
 * auditable, and nothing on the trading server has to accept inbound control traffic.
 *
 * These are the commands both bots accept, with the same shape. Each bot builds its own
 * discriminated union from them and its own commands; the order of that union is the bot's.
 */

export const pauseCommand = z.object({ type: z.literal("pause"), reason: z.string().max(200).optional() })

export const resumeCommand = z.object({ type: z.literal("resume") })

export const killSwitchEngageCommand = z.object({
  type: z.literal("kill_switch.engage"),
  reason: z.string().min(1).max(200),
  /** Also close every position at market. Off by default: halting is usually enough. */
  liquidate: z.boolean(),
})

export const killSwitchReleaseCommand = z.object({ type: z.literal("kill_switch.release"), confirm: z.literal("RELEASE") })

export const settingsUpdateCommand = z.object({
  type: z.literal("settings.update"),
  /** Deep partial of Settings; validated against the full schema after merging. */
  patch: z.record(z.string(), z.unknown()),
  /** Optimistic concurrency: rejected if settings changed since the form was loaded. */
  expected_version: z.number().int().nonnegative(),
})

/**
 * One-time seed buy: at `at`, research and an AI allocation put about `amount_usd` into long-term
 * core holdings. The engine refuses it once a seed has completed, unless `force` is set.
 */
export const seedScheduleCommand = z.object({
  type: z.literal("seed.schedule"),
  amount_usd: z.number().min(100).max(10_000),
  at: z.iso.datetime({ offset: true }),
  force: z.boolean().optional(),
})

export const seedCancelCommand = z.object({ type: z.literal("seed.cancel") })

/** Runs a stored news item through the trigger policy and reports what it would do. Never starts a cycle. */
export const wireReplayCommand = z.object({ type: z.literal("wire.replay"), item_id: z.string().min(8).max(64) })

/** A question for the agent (docs/plans/LOCAL-AI.md §11): a read-only episode whose reply shows on the Agent page. Nothing it decides is acted on. */
export const agentAskCommand = z.object({ type: z.literal("agent.ask"), question: z.string().trim().min(3).max(500) })

/** Lifts a circuit breaker's pause on the agent's new entries. Its total-loss breaker counts afresh from now. */
export const agentResumeEntriesCommand = z.object({ type: z.literal("agent.resume_entries") })

export type BaseCommand = z.infer<
  | typeof pauseCommand
  | typeof resumeCommand
  | typeof killSwitchEngageCommand
  | typeof killSwitchReleaseCommand
  | typeof settingsUpdateCommand
  | typeof seedScheduleCommand
  | typeof seedCancelCommand
  | typeof wireReplayCommand
  | typeof agentAskCommand
  | typeof agentResumeEntriesCommand
>
export type BaseCommandType = BaseCommand["type"]

export const BASE_COMMAND_LABEL: Record<BaseCommandType, string> = {
  pause: "Pause trading",
  resume: "Resume trading",
  "kill_switch.engage": "Engage kill switch",
  "kill_switch.release": "Release kill switch",
  "settings.update": "Update settings",
  "seed.schedule": "Schedule seed buy",
  "seed.cancel": "Cancel seed buy",
  "wire.replay": "Replay news item",
  "agent.ask": "Ask the agent",
  "agent.resume_entries": "Resume the agent's entries",
}
