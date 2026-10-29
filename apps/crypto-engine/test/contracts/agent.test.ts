import { toolProtocol } from "@mb/agent/episode"
import { jsonSchemaOf } from "@mb/agent/tools"
import { AGENT_LIMITS, PRIORITY_LABEL, WATCH_KINDS, WATCH_PRIORITY } from "@mb/core/agent"
import { cryptoAgentAnswerSchema } from "@mb/crypto-core/agent"
import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { describe, it } from "vitest"
import type { CryptoAgentDeps } from "../../src/agent/book"
import { CRYPTO_AGENT_PROMPT_VERSION, cryptoAgentSystemPrompt } from "../../src/agent/prompts"
import { cryptoAgentTools } from "../../src/agent/tools"
import { checkNoOrphans, matchContract, matchJson } from "./snapshot"

/**
 * The agent's contract (docs/plans/LOCAL-AI.md §13): its system message as the model gets it (the
 * prompt, the tool list and the turn protocol, at the P1 step limit), the tools' argument schemas
 * and the answer schema the grammar enforces, and the agent's fixed limits.
 */

// Building the tools runs nothing; they only read their deps when called.
const TOOLS = cryptoAgentTools({} as CryptoAgentDeps)

describe("contracts: the agent", () => {
  it("system message", () => matchContract("agent/system.txt", `${cryptoAgentSystemPrompt()}\n\n${toolProtocol(TOOLS, DEFAULT_SETTINGS.agent.limits.p1.steps)}\n`))

  it("tool and answer schemas", () =>
    matchJson("agent/schemas.json", {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, args: jsonSchemaOf(t.args) })),
      answer: jsonSchemaOf(cryptoAgentAnswerSchema),
    }))

  it("prompt version and limits", () =>
    matchJson("agent/meta.json", { prompt_version: CRYPTO_AGENT_PROMPT_VERSION, limits: AGENT_LIMITS, watch_kinds: WATCH_KINDS, watch_priority: WATCH_PRIORITY, priority_label: PRIORITY_LABEL }))

  it("no stale snapshots", () => checkNoOrphans("agent", ["system.txt", "schemas.json", "meta.json"]))
})
