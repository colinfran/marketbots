import { describe, expect, it } from "vitest"
import { ClusterIndex, jaccard, titleTokens } from "../src/cluster"

const NOW = new Date("2026-10-27T12:00:00Z")

describe("cluster", () => {
  it("groups near-duplicates with overlapping symbols inside the window", () => {
    expect(jaccard(titleTokens("SEC approves spot Solana ETF"), titleTokens("SEC approves spot Solana ETFs, a first"))).toBeGreaterThanOrEqual(0.6)
    const c = new ClusterIndex()
    c.add("a", "SEC approves spot Solana ETF", ["SOL/USD"], NOW.getTime(), "coindesk.com")
    const root = c.match("SEC approves spot Solana ETF today", ["SOL/USD"], NOW.getTime() + 60_000)
    expect(root?.id).toBe("a")
    expect(c.match("SEC approves spot Solana ETF today", ["ETH/USD"], NOW.getTime())).toBeNull()
    expect(c.match("SEC approves spot Solana ETF today", ["SOL/USD"], NOW.getTime() + 7 * 3_600_000)).toBeNull()
    expect(c.confirm(root!, "SEC approves spot Solana ETF today", "theblock.co")).toBe(true)
    // A syndicated copy of a title already seen counts once, whatever domain carries it.
    expect(c.confirm(root!, "SEC approves spot Solana ETF today", "yahoo.com")).toBe(false)
    expect(c.confirm(root!, "SEC approves spot Solana ETF, says agency", "coindesk.com")).toBe(false)
  })
})
