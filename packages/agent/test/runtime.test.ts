import type { AgentAction, AgentAnswerBase } from "@mb/core/agent"
import { agentAnswerFields } from "@mb/core/agent"
import type { AgentSettings } from "@mb/core/settings"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ChatFn } from "../src/client"
import { Agent, type AgentBot, type EpisodeInfo } from "../src/runtime"
import { defineTool } from "../src/tools"
import { obs, reply, scriptedChat, SETTINGS, useAgentDb } from "./helpers"

const answerSchema = z.object({ decisions: z.array(z.object({ symbol: z.string(), action: z.enum(["buy", "hold"]) })), ...agentAnswerFields })
type Answer = z.infer<typeof answerSchema>

const answer = (a: Partial<Answer> = {}): Answer => ({ decisions: [{ symbol: "SOL/USD", action: "buy" }], watches: [], cancel_watches: [], notes: [], reply: "Bought SOL on the breakout.", ...a })

describe("agent runtime", () => {
  const db = useAgentDb()

  const setup = ({ chat, settings = SETTINGS, blocked = null, prices = { "SOL/USD": 180 } }: { chat: ChatFn | null; settings?: AgentSettings; blocked?: string | null; prices?: Record<string, number> }) => {
    let t = Date.parse("2026-10-28T14:00:00Z")
    const events: { type: string; data: unknown; summary: string }[] = []
    const acted: EpisodeInfo[] = []
    const calls = { record: vi.fn(async () => undefined) }
    const archive = { saveEpisode: vi.fn(async () => undefined) }
    const bot: AgentBot<Answer & AgentAnswerBase> = {
      promptVersion: "test-1",
      system: () => "SYSTEM",
      brief: async (wake) => ({ text: `BOOK for ${wake.subject}`, urls: ["https://example.com/a"] }),
      tools: [defineTool({ name: "quote", description: "price", args: z.object({ symbol: z.string() }), run: async ({ symbol }) => `${symbol} ${prices[symbol] ?? "?"}` })],
      answer: answerSchema,
      known: (s) => s in prices,
      act: async (a, episode): Promise<AgentAction[]> => {
        acted.push(episode)
        return a.decisions.map((d) => ({ symbol: d.symbol, action: d.action, conviction: 60, outcome: "filled", detail: null }))
      },
      shadow: async () => null,
    }
    const agent = new Agent({
      col: db.col,
      bus: { emit: (type, data, meta) => events.push({ type, data, summary: meta.summary }) },
      log: silentLogger,
      settings: () => settings,
      settingsVersion: () => 7,
      chat,
      calls,
      alert: async () => undefined,
      blocked: () => blocked,
      price: (s) => prices[s] ?? null,
      bot,
      archive,
      signal: new AbortController().signal,
      now: () => new Date(t),
    })
    const run = async () => {
      await agent.tick()
      await agent.current
    }
    return { agent, events, acted, calls, archive, advance: (ms: number) => (t += ms), at: () => new Date(t), run }
  }

  it("ignores observations while the level is off", async () => {
    const { agent, advance, run, events } = setup({ chat: scriptedChat([]).chat, settings: { ...SETTINGS, level: "off" } })
    agent.observe(obs({ subject: "SOL/USD" }))
    advance(30_000)
    await run()
    expect(events).toEqual([])
    expect(agent.status().state).toBe("off")
  })

  it("wakes, looks something up, answers, stores watches and notes, and hands decisions to the bot", async () => {
    const { chat, requests } = scriptedChat([
      reply({ kind: "tool", purpose: "check SOL", tool: "quote", args: { symbol: "SOL/USD" } }),
      reply({
        kind: "answer",
        answer: answer({
          watches: [{ kind: "price_below", symbol: "SOL/USD", level: 170, at: null, hours: 12, priority: "risk", note: "breakdown" }],
          notes: [{ subject: "SOL/USD", text: "Bought the 180 breakout." }],
        }),
      }),
    ])
    const { agent, advance, at, run, events, acted, calls, archive } = setup({ chat })
    agent.observe(obs({ subject: "SOL/USD", priority: 1, salience: 72, summary: "breakout on volume", at: at() }))
    advance(6_000)
    await run()

    const [doc] = await db.col.agentEpisodes.find().toArray()
    expect(doc).toMatchObject({ status: "answered", subject: "SOL/USD", priority: 1, reply: "Bought SOL on the breakout.", watches_set: 1, notes_set: 1, level: "shadow", settings_version: 7, prompt_version: "test-1" })
    expect(doc.memory).toEqual(["watch set: SOL/USD below 170", "note on SOL/USD"])
    expect(doc.actions).toEqual([{ symbol: "SOL/USD", action: "buy", conviction: 60, outcome: "filled", detail: null }])
    expect(doc.expires_at).toBeNull()
    expect(doc.brief).toContain("WOKE FOR: SOL/USD (P1 opportunity)")
    expect(doc.brief).toContain("BOOK for SOL/USD")
    expect(requests[0].messages[1].content).toBe(doc.brief)
    expect(acted[0]).toMatchObject({ readOnly: false })
    expect(acted[0].urls.has("https://example.com/a")).toBe(true)
    expect(await db.col.agentWatches.countDocuments({ status: "active" })).toBe(1)
    expect(await db.col.agentNotes.countDocuments({ subject: "SOL/USD" })).toBe(1)
    expect(calls.record).toHaveBeenCalledWith(expect.objectContaining({ task: "agent", cycle_id: doc._id, ok: true }))
    expect(archive.saveEpisode).toHaveBeenCalledOnce()
    expect(events.map((e) => e.type)).toEqual(["agent.woke", "agent.step", "agent.step", "agent.watch", "agent.answered"])
    expect(agent.status()).toMatchObject({ state: "idle", episodes_today: 1, watches: 1 })
  })

  it("answers the owner's question without acting on it", async () => {
    const { chat } = scriptedChat([reply({ kind: "answer", answer: answer({ reply: "Nothing worth buying right now." }) })])
    const { agent, advance, run, acted } = setup({ chat })
    agent.ask("Anything worth buying?", "owner@example.com")
    advance(11_000)
    await run()
    const [doc] = await db.col.agentEpisodes.find().toArray()
    expect(doc).toMatchObject({ subject: "OWNER", question: "Anything worth buying?", reply: "Nothing worth buying right now.", actions: [] })
    expect(doc.brief).toContain("THE OWNER ASKS")
    expect(acted).toEqual([])
  })

  it("wakes on its own watch when the price crosses it", async () => {
    const prices = { "SOL/USD": 180 }
    const { chat } = scriptedChat([
      reply({ kind: "answer", answer: answer({ decisions: [], watches: [{ kind: "price_above", symbol: "SOL/USD", level: 185, at: null, hours: 24, priority: "opportunity", note: "retest?" }] }) }),
      reply({ kind: "answer", answer: answer({ decisions: [] }) }),
    ])
    const { agent, advance, at, run, events } = setup({ chat, prices })
    agent.observe(obs({ subject: "SOL/USD", at: at() }))
    advance(11_000)
    await run()
    prices["SOL/USD"] = 186
    await run()
    advance(6_000)
    await run()
    const docs = await db.col.agentEpisodes.find().sort({ started_at: 1 }).toArray()
    expect(docs).toHaveLength(2)
    expect(docs[1].observations[0]).toMatchObject({ kind: "watch", urgent: true })
    expect(events.filter((e) => e.type === "agent.watch").map((e) => (e.data as { status: string }).status)).toEqual(["set", "fired"])
  })

  it("waits while trading is paused", async () => {
    const { agent, advance, at, run } = setup({ chat: scriptedChat([]).chat, blocked: "trading is paused" })
    agent.observe(obs({ subject: "SOL/USD", at: at() }))
    advance(11_000)
    await run()
    expect(agent.status()).toMatchObject({ state: "queued", blocked: "trading is paused" })
    expect(await db.col.agentEpisodes.countDocuments()).toBe(0)
  })

  it("lets a P0 preempt a running review", async () => {
    // The review's step waits until it is aborted; the P0's answers at once.
    const chat: ChatFn = (r) =>
      r.messages[1].content.includes("WOKE FOR: MARKET")
        ? new Promise((resolve) => {
            const aborted = () => resolve(reply({}, { ok: false, aborted: true, error: "aborted", json: undefined, content: "" }))
            if (r.signal?.aborted) aborted()
            else r.signal?.addEventListener("abort", aborted)
          })
        : Promise.resolve(reply({ kind: "answer", answer: answer({ decisions: [], reply: "Checked the drop." }) }))
    const { agent, advance, at, run } = setup({ chat })
    agent.observe(obs({ subject: "MARKET", priority: 2, at: at() }))
    advance(11_000)
    await agent.tick()
    const first = agent.current
    agent.observe(obs({ subject: "SOL/USD", priority: 0, salience: 90, at: at() }))
    advance(2_500)
    await agent.tick()
    await first
    await run()
    const docs = await db.col.agentEpisodes.find().sort({ started_at: 1 }).toArray()
    expect(docs.map((d) => [d.subject, d.status, d.error])).toEqual([
      ["MARKET", "aborted", "preempted by a P0"],
      ["SOL/USD", "answered", null],
    ])
  })
})
