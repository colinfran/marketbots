import { describe, expect, it, vi } from "vitest"
import { CommandProcessor, type CommandHandler } from "../src/commands"
import { silentLogger } from "../src/log"
import { makeTestBus } from "../src/testing/bus"
import { EPHEMERAL, testCommandSchema, useTestDb, type TestCommand, type TestEvents } from "./helpers/bot"

const db = useTestDb()

const setup = async (handle: CommandHandler<TestCommand> = async () => "ok") => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  const processor = new CommandProcessor<TestCommand>(db.col, bus, silentLogger, handle, { schema: testCommandSchema, expiring: new Set(["resume"]) })
  return { bus, processor }
}

const queued = (id: string, command: TestCommand, created_at = new Date()) => ({ _id: id, type: command.type, command, status: "pending" as const, created_at, created_by: "owner", processed_at: null, result: null, error: null })

describe("CommandProcessor", () => {
  it("runs the queue: re-validates, executes, and expires stale risk-increasing commands", async () => {
    const handled: string[] = []
    const { bus, processor } = await setup(async (c) => {
      handled.push(c.type)
      return "ok"
    })
    const old = new Date(Date.now() - 60 * 60_000)
    await db.col.commands.insertMany([queued("1", { type: "pause" }, old), queued("2", { type: "resume" }, old), { ...queued("3", { type: "pause" }), command: { type: "settings.update", patch: {}, expected_version: -1 } as never }])
    await processor.drain()
    expect(handled).toEqual(["pause"])
    const docs = Object.fromEntries((await db.col.commands.find().toArray()).map((d) => [d._id, d]))
    expect(docs["1"].status).toBe("done")
    expect(docs["2"]).toMatchObject({ status: "rejected", error: expect.stringMatching(/expired/) })
    expect(docs["3"].status).toBe("rejected")
    expect(await db.col.audit.countDocuments()).toBe(3)
    await bus.stop()
  })

  it("runs a command sent straight to it at once, keeps its outcome for the page, and records it after", async () => {
    const { bus, processor } = await setup(async (c) => `${c.type}d`)
    expect(processor.submit("d1", { type: "pause" }, "owner")).toEqual({ ok: true })
    expect(processor.status("d1")).toMatchObject({ _id: "d1", type: "pause" })
    await processor.idle()
    expect(processor.status("d1")).toEqual({ _id: "d1", type: "pause", status: "done", result: "paused", error: null })
    expect(await db.col.commands.findOne({ _id: "d1" })).toMatchObject({ type: "pause", status: "done", result: "paused", created_by: "owner" })
    expect(await db.col.audit.findOne({ target: "d1" })).toMatchObject({ actor: "engine", action: "command.done", details: { type: "pause", requested_by: "owner" } })
    await bus.stop()
  })

  it("refuses an invalid command or a taken id at once, before running anything", async () => {
    const handle = vi.fn(async () => "ok")
    const { bus, processor } = await setup(handle)
    expect(processor.submit("d1", { type: "launch" }, "owner")).toMatchObject({ ok: false, status: 400 })
    expect(processor.submit("d2", { type: "pause" }, "owner")).toEqual({ ok: true })
    expect(processor.submit("d2", { type: "pause" }, "owner")).toMatchObject({ ok: false, status: 409 })
    await processor.idle()
    expect(handle).toHaveBeenCalledTimes(1)
    await bus.stop()
  })

  it("runs once a command the dashboard also queued (it stopped waiting for the engine's answer)", async () => {
    let release = () => undefined as void
    const held = new Promise<void>((r) => (release = r))
    const handle = vi.fn(async () => {
      await held
      return "paused"
    })
    const { bus, processor } = await setup(handle)
    processor.submit("d1", { type: "pause" }, "owner")
    await db.col.commands.insertOne(queued("d1", { type: "pause" }))
    const draining = processor.drain()
    release()
    await draining
    expect(handle).toHaveBeenCalledTimes(1)
    expect(await db.col.commands.findOne({ _id: "d1" })).toMatchObject({ status: "done", result: "paused" })
    await bus.stop()
  })

  it("never fails or holds up a command over a database that can't record it", async () => {
    const { bus, processor } = await setup(async () => "paused")
    const failing = vi.spyOn(db.col.commands, "replaceOne").mockRejectedValue(new Error("An unexpected internal error has occurred."))
    processor.submit("d1", { type: "pause" }, "owner")
    await processor.idle()
    expect(processor.status("d1")).toMatchObject({ status: "done", result: "paused" })
    failing.mockRestore()
    await bus.stop()
  })
})
