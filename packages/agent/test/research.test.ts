import type { LocalResearch } from "@mb/wire/research/local"
import { describe, expect, it, vi } from "vitest"
import { callTool, toolsFor } from "../src/tools"
import { researchTool } from "../src/wire-tools"

const NOW = Date.parse("2026-10-30T12:00:00Z")
const ctx = (deadline?: number) => ({ episodeId: "e1", urls: new Set<string>(), signal: new AbortController().signal, deadline })

describe("the research tool", () => {
  it("researches one question on the free engines only, inside the episode's time, and returns a fenced memo with its sources", async () => {
    const research = vi.fn<LocalResearch>(async () => ({
      memo: "SOL fell after an exchange delisted it [https://news.example/sol].",
      sources: [{ title: "Exchange delists SOL", url: "https://news.example/sol", domain: "news.example" }],
      queries: ["SOL delisting"],
      usage: { input: 1, output: 1, total: 2 },
      error: null,
    }))
    const tool = researchTool(research, () => "local/qwen", () => NOW)
    const tc = ctx(NOW + 120_000)
    const r = await callTool([tool], "research", { question: "Why did SOL/USD fall 8% today?" }, tc)
    expect(research).toHaveBeenCalledWith(expect.objectContaining({ model: "local/qwen", prompt: "Why did SOL/USD fall 8% today?", fromDate: "2026-10-23", timeoutMs: 115_000, freeOnly: true, label: "Why did SOL/USD fall 8% today?" }))
    expect(r.result).toContain('<untrusted source="research memo">')
    expect(r.result).toContain("- Exchange delists SOL (news.example) https://news.example/sol")
    expect([...tc.urls]).toEqual(["https://news.example/sol"])
  })

  it("doesn't start without the time for it, without the search service, or on a vague question", async () => {
    const research = vi.fn<LocalResearch>()
    const tool = researchTool(research, () => "local/qwen", () => NOW)
    expect((await callTool([tool], "research", { question: "Why did SOL fall?" }, ctx(NOW + 30_000))).result).toMatch(/^not enough time left/)
    expect((await callTool([tool], "research", { question: "SOL?" }, ctx(NOW + 120_000))).result).toBe("ask a full question")
    expect(research).not.toHaveBeenCalled()
    expect((await callTool([researchTool(null, () => "local/qwen")], "research", { question: "Why did SOL fall?" }, ctx())).result).toMatch(/^web research is unavailable/)
  })

  it("is offered only to reviews and background episodes", () => {
    const tools = [researchTool(null, () => "m")]
    expect(toolsFor(tools, 0)).toEqual([])
    expect(toolsFor(tools, 1)).toEqual([])
    expect(toolsFor(tools, 2).map((t) => t.name)).toEqual(["research"])
    expect(toolsFor(tools, 3).map((t) => t.name)).toEqual(["research"])
  })
})
