import type { AgentAction, AgentAnswerBase } from "@mb/core/agent"
import { agentAnswerFields } from "@mb/core/agent"
import type { AgentSettings } from "@mb/core/settings"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ChatFn } from "../src/client"
import { Agent, type AgentAccount, type AgentBot, type EpisodeInfo, type Pause, type Promotion } from "../src/runtime"
import { defineTool } from "../src/tools"
import { obs, reply, scriptedChat, SETTINGS, useAgentDb } from "./helpers"

const answerSchema = z.object({ decisions: z.array(z.object({ symbol: z.string(), action: z.enum(["buy", "hold"]) })), ...agentAnswerFields })
type Answer = z.infer<typeof answerSchema>

const answer = (a: Partial<Answer> = {}): Answer => ({ decisions: [{ symbol: "SOL/USD", action: "buy" }], watches: [], cancel_watches: [], notes: [], reply: "Bought SOL on the breakout.", ...a })

describe("agent runtime", () => {
  const db = useAgentDb()

  const setup = ({
    chat,
    settings = SETTINGS,
    blocked = null,
    prices = { "SOL/USD": 180 },
    skip,
    outcomes,
    accountOf = () => null,
    promotion,
  }: {
    chat: ChatFn | null
    settings?: AgentSettings
    blocked?: string | null
    prices?: Record<string, number>
    skip?: AgentBot<Answer>["skip"]
    /** What the bot reports for each decision, in place of "filled". */
    outcomes?: Pick<AgentAction, "outcome" | "detail">[]
    accountOf?: () => AgentAccount | null
    promotion?: Promotion | null
  }) => {
    let t = Date.parse("2026-10-28T14:00:00Z")
    let current = settings
    let promoted = promotion ?? null
    let paused: Pause | null = null
    const pauseSet = vi.fn(async (p: Pause | null) => {
      paused = p
    })
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
        return a.decisions.map((d, i) => ({ symbol: d.symbol, action: d.action, conviction: 60, outcome: "filled", detail: null, ...outcomes?.[i] }))
      },
      account: async () => accountOf(),
      skip,
    }
    const agent = new Agent({
      col: db.col,
      bus: { emit: (type, data, meta) => events.push({ type, data, summary: meta.summary }) },
      log: silentLogger,
      settings: () => current,
      settingsVersion: () => 7,
      chat,
      calls,
      alert: async () => undefined,
      blocked: () => blocked,
      price: (s) => prices[s] ?? null,
      bot,
      archive,
      pause: { get: () => paused, set: pauseSet },
      promotion: {
        get: () => promoted,
        set: async (p) => {
          promoted = p
        },
      },
      signal: new AbortController().signal,
      now: () => new Date(t),
    })
    const run = async () => {
      await agent.tick()
      await agent.current
    }
    return {
      agent,
      events,
      acted,
      calls,
      archive,
      pauseSet,
      paused: () => paused,
      advance: (ms: number) => (t += ms),
      at: () => new Date(t),
      run,
      setLevel: (level: AgentSettings["level"]) => (current = { ...current, level }),
      level: () => current.level,
      promoted: () => promoted,
    }
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
    expect(doc).toMatchObject({ status: "answered", subject: "SOL/USD", priority: 1, reply: "Bought SOL on the breakout.", watches_set: 1, notes_set: 1, level: "on", settings_version: 7, prompt_version: "test-1" })
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

  it("drops a wake-up the bot says isn't worth an episode", async () => {
    const { agent, advance, at, run } = setup({ chat: scriptedChat([]).chat, skip: async (wake) => (wake.subject === "SOL/USD" ? "the envelope refuses entries" : null) })
    agent.observe(obs({ subject: "SOL/USD", kind: "setup", priority: 1, at: at() }))
    advance(6_000)
    await run()
    expect(await db.col.agentEpisodes.countDocuments()).toBe(0)
    expect(agent.queue.size).toBe(0)
  })

  it("counts buys its envelope refused toward the envelope breaker, but not buys refused for their timing", async () => {
    const buys = answer({ decisions: ["A", "B", "C"].map((s) => ({ symbol: `${s}/USD`, action: "buy" as const })) })
    const run = async (detail: string) => {
      const { chat } = scriptedChat([reply({ kind: "answer", answer: buys })])
      const { agent, advance, at, run, events } = setup({ chat, outcomes: Array.from({ length: 3 }, () => ({ outcome: "blocked" as const, detail })) })
      agent.observe(obs({ subject: "SOL/USD", at: at() }))
      advance(11_000)
      await run()
      return events.filter((e) => e.type === "agent.breaker").map((e) => (e.data as { name: string }).name)
    }
    expect(await run("buys only in the regular session after the opening buffer")).toEqual([])
    await db.col.agentEpisodes.deleteMany({})
    expect(await run("envelope: 2/2 in the last hour")).toEqual(["envelope_blocks"])
  })

  describe("breakers and the owner's controls", () => {
    const account = (equity: number, dayPnlPct = 0): AgentAccount => ({
      account: { starting_usd: 10_000, cash_usd: equity, equity_usd: equity, exposure_usd: 0, realized_pnl_usd: 0, unrealized_pnl_usd: 0, return_pct: (equity / 10_000 - 1) * 100, open_positions: 0, closed_positions: 0 },
      dayPnlPct,
    })
    const ON = SETTINGS

    it("records the equity when turned on, counts the total loss from it, and pauses entries when a breaker trips until the owner resumes them", async () => {
      let equity = 12_000
      const { chat } = scriptedChat([reply({ kind: "answer", answer: answer({ decisions: [] }) }), reply({ kind: "answer", answer: answer() })])
      const { agent, advance, at, run, events, pauseSet, paused, promoted, setLevel, acted } = setup({ chat, settings: { ...SETTINGS, level: "off" }, accountOf: () => account(equity) })
      await run()
      setLevel("on")
      await run()
      expect(promoted()).toEqual({ at: at(), equity_usd: 12_000 })
      expect(agent.status()).toMatchObject({ level: "on", pause: null, entries_paused: null })
      // Down 7% since it was turned on, though still up 4% since the account started.
      equity = 11_160
      advance(16_000)
      agent.observe(obs({ subject: "SOL/USD", at: at() }))
      advance(11_000)
      await run()
      expect(pauseSet).toHaveBeenCalledWith({ at: at(), reason: expect.stringMatching(/^total loss: /) }, "engine:agent-breaker")
      expect(agent.status()).toMatchObject({ level: "on", pause: { reason: expect.stringMatching(/^total loss: /) } })
      expect(events.find((e) => e.type === "agent.breaker")?.summary).toMatch(/new entries pause until you resume them; its exits carry on$/)
      // The agent keeps working, with its entries paused.
      advance(400_000)
      agent.observe(obs({ subject: "ETH/USD", at: at() }))
      advance(11_000)
      await run()
      expect(acted.at(-1)?.entriesPaused).toMatch(/^entries paused by a breaker until the owner resumes them: total loss/)
      // Resuming lifts the pause and counts the loss afresh from the equity now.
      expect(await agent.resumeEntries("owner@example.com")).toMatch(/^the agent's entries resumed/)
      expect(paused()).toBeNull()
      expect(promoted()).toEqual({ at: at(), equity_usd: 11_160 })
      expect(agent.entriesPaused()).toBeNull()
      await expect(agent.resumeEntries("owner@example.com")).rejects.toThrow("the agent's entries aren't paused")
    })

    it("keeps a promotion recorded before a restart", async () => {
      const before = { at: new Date("2026-10-27T10:00:00Z"), equity_usd: 9_000 }
      const { run, promoted } = setup({ chat: scriptedChat([]).chat, settings: ON, accountOf: () => account(10_000), promotion: before })
      await run()
      expect(promoted()).toBe(before)
    })

    it("pauses entries while the model is slow, without a pause the owner must lift, and tells the bot", async () => {
      const slow = reply({ kind: "answer", answer: answer({ decisions: [] }) }, { gen_per_s: 20 })
      const { chat } = scriptedChat(Array.from({ length: 6 }, () => slow))
      const { agent, advance, at, run, acted, pauseSet } = setup({ chat, settings: ON, accountOf: () => account(10_000) })
      for (let i = 0; i < 6; i++) {
        agent.observe(obs({ subject: `S${i}/USD`, at: at() }))
        advance(11_000)
        await run()
      }
      expect(acted.at(-1)?.entriesPaused).toMatch(/^entries paused: the last 5 steps generated under 35 tokens\/s/)
      expect(agent.status().entries_paused).not.toBeNull()
      expect(pauseSet).not.toHaveBeenCalled()
    })

    it("turns the owner's Wake the agent into a review it may act on", async () => {
      const { chat } = scriptedChat([reply({ kind: "answer", answer: answer() })])
      const { agent, advance, run, acted } = setup({ chat, settings: ON, accountOf: () => account(10_000) })
      expect(agent.review(["SOL/USD"], "owner@example.com")).toBe("the agent will review SOL/USD now: see the Agent page")
      advance(6_000)
      await run()
      const [doc] = await db.col.agentEpisodes.find().toArray()
      expect(doc).toMatchObject({ subject: "SOL/USD", priority: 1, question: null })
      expect(acted[0]).toMatchObject({ readOnly: false })
    })
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
