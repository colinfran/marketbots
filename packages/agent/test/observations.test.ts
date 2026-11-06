import { describe, expect, it } from "vitest"
import { newsObservations, newsWoke } from "../src/observations"
import { obs } from "./helpers"

const item = { _id: "item-1", title: "SOL network halts", severity: 80, first_seen_at: new Date("2026-11-06T14:00:00Z"), category: "outage", source: "rss:x" }

describe("observations", () => {
  it("turns a news trigger into one observation per symbol, a P0 for bad news on a holding", () => {
    const o = newsObservations(item, { rule: "holding_negative", action: "review", symbols: ["SOL/USD", "ETH/USD"] }, { held: new Set(["SOL/USD"]), critical: 85 })
    expect(o.map((x) => [x.subject, x.kind, x.priority])).toEqual([
      ["SOL/USD", "news", 0],
      ["ETH/USD", "news", 2],
    ])
  })

  it("lets the agent close a trend-core position only when news about it woke the episode, or the owner asked", () => {
    expect(newsWoke([obs({ subject: "SOL/USD", kind: "news" })], "SOL/USD")).toBe(true)
    expect(newsWoke([obs({ subject: "ETH/USD", kind: "news" })], "SOL/USD")).toBe(false)
    // A price move, a setup or a quiet-time review is no reason: the trailing stop handles price.
    expect(newsWoke([obs({ subject: "SOL/USD", kind: "price" }), obs({ subject: "MARKET", kind: "sweep" })], "SOL/USD")).toBe(false)
    expect(newsWoke([obs({ id: "review:abc", subject: "SOL/USD", kind: "sweep" })], "SOL/USD")).toBe(true)
  })
})
