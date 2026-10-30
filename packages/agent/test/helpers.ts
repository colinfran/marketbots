import type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc, Observation } from "@mb/core/agent"
import type { AgentSettings } from "@mb/core/settings"
import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import type { Db } from "mongodb"
import type { ChatFn, ChatRequest, ChatResult } from "../src/client"

/** The agent's collections on a fresh test database. */
export const useAgentDb = () =>
  useMongoTestDb({
    prefix: "agent_test",
    indexes: {},
    collections: (db: Db) => ({
      agentEpisodes: db.collection<AgentEpisodeDoc>("agent_episodes"),
      agentWatches: db.collection<AgentWatchDoc>("agent_watches"),
      agentNotes: db.collection<AgentNoteDoc>("agent_notes"),
    }),
  })

export const SETTINGS: AgentSettings = {
  level: "on",
  model: "local/test-model",
  limits: {
    p0: { steps: 4, seconds: 60, thinking_tokens: 0 },
    p1: { steps: 6, seconds: 120, thinking_tokens: 0 },
    p2: { steps: 8, seconds: 240, thinking_tokens: 1_024 },
    p3: { steps: 12, seconds: 600, thinking_tokens: 2_048 },
  },
  wake_cooldown_minutes: 5,
  sweep_minutes: 120,
  envelope: {
    entries_per_day: 4,
    entries_per_hour: 2,
    commit_per_hour_pct: 10,
    size_pct: 50,
    max_open_positions: 4,
    symbol_action_minutes: 30,
    reentry_after_stop_hours: 24,
    flip_hours: 6,
  },
  public_thinking: false,
}

export const obs = (fields: Partial<Observation> & Pick<Observation, "subject">): Observation => ({
  id: `o-${Math.random().toString(36).slice(2)}`,
  kind: "news",
  priority: 2,
  salience: 50,
  summary: "something happened",
  refs: {},
  at: new Date(),
  ...fields,
})

/** A model reply: the JSON object it wrote, as the server would stream it back. */
export const reply = (json: unknown, fields: Partial<ChatResult> = {}): ChatResult => ({
  ok: true,
  error: null,
  aborted: false,
  content: JSON.stringify(json),
  reasoning: "",
  json,
  wall_ms: 1_000,
  prompt_tokens: 500,
  completion_tokens: 50,
  cached_tokens: 400,
  gen_per_s: 44,
  finish_reason: "stop",
  ...fields,
})

/** A scripted model: each call returns the next reply (or what `fn` makes of the request). */
export const scriptedChat = (replies: (ChatResult | ((r: ChatRequest) => ChatResult | Promise<ChatResult>))[]) => {
  const requests: ChatRequest[] = []
  const chat: ChatFn = async (r) => {
    requests.push({ ...r, messages: [...r.messages] })
    const next = replies.shift()
    if (!next) throw new Error("the script ran out of replies")
    return typeof next === "function" ? next(r) : next
  }
  return { chat, requests }
}
