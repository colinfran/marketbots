import { describe, expect, it } from "vitest"
import { cancelSeed, claimDueSeed, failInterruptedSeeds, failMissedSeeds, scheduleSeed } from "../../src/state/seed-runs"
import { useTestDb } from "../helpers/bot"

const db = useTestDb()
const NOW = new Date("2026-10-27T13:00:00Z")
const AT = "2026-10-27T13:45:00Z"

describe("seed runs", () => {
  it("schedules one run at a time and refuses a second seed after one is done unless forced", async () => {
    const run = await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(run).toMatchObject({ status: "scheduled", amount_usd: 2_000, force: false })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already scheduled/)

    await db.col.seedRuns.updateOne({ _id: run._id }, { $set: { status: "done", done_at: NOW } })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already ran/)
    await expect(scheduleSeed(db.col, { amount_usd: 1_000, at: AT, force: true }, "owner", NOW)).resolves.toMatchObject({ status: "scheduled", force: true })
  })

  it("rejects times in the past or too far ahead", async () => {
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: "2026-10-27T12:00:00Z" }, "owner", NOW)).rejects.toThrow(/in the past/)
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: "2027-03-01T12:00:00Z" }, "owner", NOW)).rejects.toThrow(/days away/)
  })

  it("claims a due run exactly once, cancels, and fails missed and interrupted runs", async () => {
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(await claimDueSeed(db.col, NOW)).toBeNull()
    const due = new Date("2026-10-27T13:46:00Z")
    expect(await claimDueSeed(db.col, due)).toMatchObject({ status: "running" })
    expect(await claimDueSeed(db.col, due)).toBeNull()
    expect(await failInterruptedSeeds(db.col, due)).toBe(1)
    expect(await db.col.seedRuns.findOne({})).toMatchObject({ status: "failed", error: expect.stringContaining("restarted") })

    await db.col.seedRuns.deleteMany({})
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    await expect(cancelSeed(db.col)).resolves.toMatchObject({ status: "canceled" })
    await expect(cancelSeed(db.col)).rejects.toThrow(/no scheduled seed/)

    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    const deadline = (r: { at: Date }) => new Date(r.at.getTime() + 120 * 60_000)
    expect(await failMissedSeeds(db.col, deadline, new Date("2026-10-27T14:00:00Z"))).toHaveLength(0)
    const missed = await failMissedSeeds(db.col, deadline, new Date("2026-10-27T16:00:00Z"))
    expect(missed).toHaveLength(1)
    expect(missed[0].error).toMatch(/missed/)
  })
})
