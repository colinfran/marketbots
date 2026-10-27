import { describe, expect, it } from "vitest"
import { CommandProcessor } from "../src/commands"
import { silentLogger } from "../src/log"
import { makeTestBus } from "../src/testing/bus"
import { EPHEMERAL, testCommandSchema, useTestDb, type TestCommand, type TestEvents } from "./helpers/bot"

const db = useTestDb()

describe("CommandProcessor", () => {
  it("re-validates, executes, and expires stale risk-increasing commands", async () => {
    const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
    const handled: string[] = []
    const processor = new CommandProcessor<TestCommand>(
      db.col,
      bus,
      silentLogger,
      async (c) => {
        handled.push(c.type)
        return "ok"
      },
      { schema: testCommandSchema, expiring: new Set(["resume"]) },
    )
    const now = new Date()
    const old = new Date(Date.now() - 60 * 60_000)
    await db.col.commands.insertMany([
      { _id: "1", type: "pause", command: { type: "pause" }, status: "pending", created_at: old, created_by: "owner", processed_at: null, result: null, error: null },
      { _id: "2", type: "resume", command: { type: "resume" }, status: "pending", created_at: old, created_by: "owner", processed_at: null, result: null, error: null },
      { _id: "3", type: "settings.update", command: { type: "settings.update", patch: {}, expected_version: -1 } as never, status: "pending", created_at: now, created_by: "owner", processed_at: null, result: null, error: null },
    ])
    await processor.drain()
    expect(handled).toEqual(["pause"])
    const docs = Object.fromEntries((await db.col.commands.find().toArray()).map((d) => [d._id, d]))
    expect(docs["1"].status).toBe("done")
    expect(docs["2"]).toMatchObject({ status: "rejected", error: expect.stringMatching(/expired/) })
    expect(docs["3"].status).toBe("rejected")
    expect(await db.col.audit.countDocuments()).toBe(3)
    await bus.stop()
  })
})
