import { describe, expect, it } from "vitest"
import { seedCancelCommand, seedScheduleCommand } from "../src/commands"

describe("seed commands", () => {
  it("accepts a seed schedule within bounds, with or without force", () => {
    expect(seedScheduleCommand.safeParse({ type: "seed.schedule", amount_usd: 2_000, at: "2026-10-27T13:45:00.000Z" }).success).toBe(true)
    expect(seedScheduleCommand.safeParse({ type: "seed.schedule", amount_usd: 2_000, at: "2026-10-27T09:45:00-04:00", force: true }).success).toBe(true)
    expect(seedCancelCommand.safeParse({ type: "seed.cancel" }).success).toBe(true)
  })

  it("rejects amounts out of range and malformed times", () => {
    expect(seedScheduleCommand.safeParse({ type: "seed.schedule", amount_usd: 50, at: "2026-10-27T13:45:00Z" }).success).toBe(false)
    expect(seedScheduleCommand.safeParse({ type: "seed.schedule", amount_usd: 20_000, at: "2026-10-27T13:45:00Z" }).success).toBe(false)
    expect(seedScheduleCommand.safeParse({ type: "seed.schedule", amount_usd: 2_000, at: "tomorrow at 9:45" }).success).toBe(false)
  })
})
