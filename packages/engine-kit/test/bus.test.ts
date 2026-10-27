import { describe, expect, it } from "vitest"
import { makeTestBus } from "../src/testing/bus"
import { EPHEMERAL, useTestDb, type TestEvents } from "./helpers/bot"

const db = useTestDb()
const makeBus = () => makeTestBus<TestEvents>(db.col, EPHEMERAL)

describe("EventBus", () => {
  it("assigns increasing seqs, persists, and replays from memory and the database", async () => {
    const bus = await makeBus()
    const a = bus.emit("alert", { level: "info", title: "a", message: "a" }, { summary: "a" })
    const b = bus.emit("alert", { level: "info", title: "b", message: "b" }, { summary: "b" })
    const tick = bus.emit("market.ticker", { symbol: "BTC/USD", bid: 1, ask: 2, last: 1.5, change_pct: null }, { summary: "t" })
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(tick.seq).toBe(0)
    await bus.flush()
    expect(await db.col.events.countDocuments()).toBe(2)
    expect((await bus.replay(a.seq)).events.map((e) => e.summary)).toEqual(["b"])
    // A new bus (engine restart) continues after the stored seqs and replays from MongoDB.
    const restarted = await makeBus()
    const c = restarted.emit("alert", { level: "info", title: "c", message: "c" }, { summary: "c" })
    expect(c.seq).toBeGreaterThan(b.seq)
    expect((await restarted.replay(0)).events.map((e) => e.summary)).toEqual(["a", "b", "c"])
    await bus.stop()
    await restarted.stop()
  })
})
