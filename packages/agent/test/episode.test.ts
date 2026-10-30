import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runEpisode, toolProtocol } from "../src/episode"
import { defineTool } from "../src/tools"
import { reply, scriptedChat } from "./helpers"

const answer = z.object({ decision: z.enum(["buy", "hold"]), reply: z.string() })

const quote = defineTool({
  name: "quote",
  description: "the live price of a symbol",
  args: z.object({ symbol: z.string() }),
  run: async ({ symbol }, ctx) => {
    ctx.urls.add(`https://example.com/${symbol}`)
    return `${symbol} 100.5`
  },
})

const broken = defineTool({ name: "broken", description: "always fails", args: z.object({}), run: async () => Promise.reject(new Error("store down")) })

const limits = { steps: 4, seconds: 60, thinking_tokens: 0 }

const input = (chat: Parameters<typeof runEpisode>[0]["chat"], over: Partial<Parameters<typeof runEpisode>[0]> = {}) => ({
  chat,
  model: "local/test-model",
  system: "You are a test agent.",
  brief: "BRIEF",
  tools: [quote, broken],
  answer,
  limits,
  ctx: { episodeId: "e1", urls: new Set<string>(), signal: new AbortController().signal },
  ...over,
})

describe("episode loop", () => {
  it("calls a tool, feeds its result back, then answers", async () => {
    const { chat, requests } = scriptedChat([
      reply({ kind: "tool", purpose: "check the price", tool: "quote", args: { symbol: "SOL/USD" } }),
      reply({ kind: "answer", answer: { decision: "hold", reply: "Price is flat." } }),
    ])
    const ctx = { episodeId: "e1", urls: new Set<string>(), signal: new AbortController().signal }
    const r = await runEpisode(input(chat, { ctx }))
    expect(r.status).toBe("answered")
    expect(r.answer).toEqual({ decision: "hold", reply: "Price is flat." })
    expect(r.steps.map((s) => [s.kind, s.tool, s.purpose])).toEqual([
      ["tool", "quote", "check the price"],
      ["answer", null, null],
    ])
    expect(ctx.urls.has("https://example.com/SOL/USD")).toBe(true)
    // The second call re-sends everything before it unchanged, plus the call and its result.
    expect(requests[1].messages.slice(0, 2)).toEqual(requests[0].messages)
    expect(requests[1].messages[3].content).toContain("TOOL RESULT (quote):\nSOL/USD 100.5")
    expect(requests[0].messages[0].content).toContain(toolProtocol([quote, broken], 4))
    expect(r.usage).toEqual({ input: 1_000, output: 100, total: 1_100 })
  })

  it("offers tools and the answer, but only the answer on the last step", async () => {
    const { chat, requests } = scriptedChat([
      reply({ kind: "tool", purpose: "a", tool: "quote", args: { symbol: "A" } }),
      reply({ kind: "tool", purpose: "b", tool: "quote", args: { symbol: "B" } }),
      reply({ kind: "tool", purpose: "c", tool: "quote", args: { symbol: "C" } }),
      reply({ kind: "answer", answer: { decision: "buy", reply: "Go." } }),
    ])
    const r = await runEpisode(input(chat))
    expect(r.status).toBe("answered")
    expect((requests[0].schema as { anyOf: unknown[] }).anyOf).toHaveLength(3)
    expect(requests[3].schema).toMatchObject({ properties: { kind: { enum: ["answer"] } } })
    expect(requests[2].messages.at(-1)!.content).toContain("2 turns left")
    expect(requests[3].messages.at(-1)!.content).toContain("Time to answer")
  })

  it("returns tool failures and bad arguments to the model as text", async () => {
    const { chat, requests } = scriptedChat([
      reply({ kind: "tool", purpose: "x", tool: "broken", args: {} }),
      reply({ kind: "tool", purpose: "y", tool: "quote", args: { symbol: 5 } }),
      reply({ kind: "answer", answer: { decision: "hold", reply: "Nothing to go on." } }),
    ])
    const r = await runEpisode(input(chat))
    expect(r.steps[0]).toMatchObject({ result: "the lookup failed: store down", error: "store down" })
    expect(r.steps[1].result).toMatch(/^invalid arguments: symbol/)
    expect(requests[2].messages.at(-1)!.content).toContain("invalid arguments")
    expect(r.status).toBe("answered")
  })

  it("asks once more for an answer that fails the schema, then gives up", async () => {
    const first = scriptedChat([reply({ kind: "answer", answer: { decision: "sell", reply: "?" } }), reply({ kind: "answer", answer: { decision: "hold", reply: "Fixed." } })])
    const fixed = await runEpisode(input(first.chat))
    expect(fixed.status).toBe("answered")
    expect(first.requests[1].temperature).toBeLessThan(first.requests[0].temperature)
    expect(first.requests[1].messages.at(-1)!.content).toMatch(/Your answer was rejected: decision/)

    const twice = scriptedChat([reply({ kind: "answer", answer: { decision: "sell", reply: "?" } }), reply({ kind: "answer", answer: { decision: "short", reply: "?" } })])
    const r = await runEpisode(input(twice.chat))
    expect(r.status).toBe("invalid")
    expect(r.answer).toBeNull()
  })

  it("ends with no answer when the time runs out", async () => {
    let t = 0
    const { chat } = scriptedChat([
      (req) => {
        t += 50_000
        return reply({ kind: "tool", purpose: "slow", tool: "quote", args: { symbol: "A" } }, { wall_ms: req.timeoutMs })
      },
      () => reply({}, { ok: false, aborted: true, error: "timed out after 10 s", json: undefined, content: "" }),
    ])
    const r = await runEpisode(input(chat, { now: () => t }))
    expect(r.status).toBe("no_answer")
    expect(r.error).toMatch(/timed out/)
  })

  it("stops when aborted (preemption or shutdown)", async () => {
    const abort = new AbortController()
    const { chat } = scriptedChat([
      () => {
        abort.abort()
        return reply({}, { ok: false, aborted: true, error: "aborted", json: undefined, content: "" })
      },
    ])
    const r = await runEpisode(input(chat, { ctx: { episodeId: "e1", urls: new Set(), signal: abort.signal } }))
    expect(r.status).toBe("aborted")
  })

  it("turns thinking on with the priority's budget and streams each step's thinking and JSON to its model call", async () => {
    const seen: string[] = []
    const { chat, requests } = scriptedChat([
      (req) => {
        req.onReasoning?.("Hmm, ")
        req.onReasoning?.("hold.")
        req.onContent?.("{\"kind\":")
        return reply({ kind: "answer", answer: { decision: "hold", reply: "Hold." } }, { reasoning: "Hmm, hold." })
      },
    ])
    const call = (n: number) => ({ id: `c${n}`, thinking: (d: string) => seen.push(`think ${n}: ${d}`), output: (d: string) => seen.push(`out ${n}: ${d}`), end: (e: { ok: boolean }) => seen.push(`end ${n}: ${e.ok}`) })
    const r = await runEpisode(input(chat, { limits: { steps: 4, seconds: 60, thinking_tokens: 1_024 }, call }))
    expect(requests[0].thinkingTokens).toBe(1_024)
    expect(seen).toEqual(["think 1: Hmm, ", "think 1: hold.", "out 1: {\"kind\":", "end 1: true"])
    expect(r.steps[0].thinking).toBe("Hmm, hold.")
  })
})
