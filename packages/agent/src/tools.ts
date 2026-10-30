import { z } from "zod"

/**
 * The agent's tools (docs/plans/LOCAL-AI.md §8.3): read-only lookups with typed arguments and
 * capped output, each call recorded in the episode. No tool writes settings, touches orders, runs
 * code or reaches a URL the episode hasn't already seen. Each bot defines its own (its engine's
 * src/agent/tools.ts) with `defineTool`.
 */

export type ToolContext = {
  episodeId: string
  /** URLs the episode has seen (brief and tool results): evidence may cite only these. Tools add the ones they return. */
  urls: Set<string>
  signal: AbortSignal
  /** When the episode's tool calls must end (ms since the epoch), so a slow tool can fit itself in; absent: no limit known. */
  deadline?: number
}

export type AgentTool = {
  name: string
  /** One line for the tool list in the system prompt: what it returns, when to use it. */
  description: string
  args: z.ZodObject
  /** Offered only to episodes of this priority or a less urgent one (2: reviews and background). */
  minPriority?: number
  /** Its result's cap in characters, when TOOL_RESULT_CHARS is too short (a research memo). */
  resultChars?: number
  run: (args: never, ctx: ToolContext) => Promise<string>
}

export const defineTool = <S extends z.ZodObject>(tool: {
  name: string
  description: string
  args: S
  minPriority?: number
  resultChars?: number
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<string>
}): AgentTool => tool as unknown as AgentTool

/** The tools an episode of this priority is offered. */
export const toolsFor = (tools: readonly AgentTool[], priority: number) => tools.filter((t) => t.minPriority === undefined || priority >= t.minPriority)

/** Longest tool result the model reads; the episode stores less (journal.ts). */
export const TOOL_RESULT_CHARS = 2_500

/** A zod schema as the JSON schema llama.cpp turns into a grammar (no `$schema` key: it may sit inside another schema). */
export const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

/** Cuts text to `max` characters, saying so. */
export const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 40)}… [cut: ${text.length.toLocaleString("en-US")} characters in all]` : text)

/** Runs a tool call the model made: arguments checked, failures returned as text, output capped. */
export const callTool = async (tools: readonly AgentTool[], name: string, args: unknown, ctx: ToolContext): Promise<{ result: string; error: string | null }> => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { result: `unknown tool "${name}"`, error: "unknown tool" }
  const parsed = tool.args.safeParse(args ?? {})
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")
    return { result: `invalid arguments: ${why}`, error: why }
  }
  try {
    return { result: cap(await tool.run(parsed.data as never, ctx), tool.resultChars ?? TOOL_RESULT_CHARS), error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { result: `the lookup failed: ${message.slice(0, 300)}`, error: message.slice(0, 300) }
  }
}
