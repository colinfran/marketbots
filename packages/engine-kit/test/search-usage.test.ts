import type { SearchUsageDoc } from "@mb/core/db"
import { describe, expect, it } from "vitest"
import { mongoSearchMeter } from "../src/state/search-usage"
import { useMongoTestDb } from "../src/testing/db"

const db = useMongoTestDb({ prefix: "search_usage", indexes: {}, collections: (d) => ({ searchUsage: d.collection<SearchUsageDoc>("search_usage") }) })

describe("search usage", () => {
  it("adds each provider's spend to its month's document, and reads a month back", async () => {
    const meter = mongoSearchMeter(db.col.searchUsage)
    expect(await meter.load("2026-10")).toEqual({})
    await meter.add("2026-10", "tavily", 1)
    await meter.add("2026-10", "tavily", 1)
    await meter.add("2026-10", "exa", 0.007)
    await meter.add("2026-11", "tavily", 1)
    expect(await meter.load("2026-10")).toEqual({ tavily: 2, exa: 0.007 })
    expect(await meter.load("2026-11")).toEqual({ tavily: 1 })
    expect(await db.col.searchUsage.countDocuments()).toBe(2)
  })
})
