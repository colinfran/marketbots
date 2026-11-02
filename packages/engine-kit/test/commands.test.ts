import { describe, expect, it, vi } from "vitest"
import { CommandProcessor, type CommandHandler } from "../src/commands"
import { silentLogger } from "../src/log"
import { makeTestBus } from "../src/testing/bus"
import { EPHEMERAL, testCommandSchema, useTestDb, type TestCommand, type TestEvents } from "./helpers/bot"

const db = useTestDb()

const setup = async (handle: CommandHandler<TestCommand> = async () => "ok") => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  const processor = new CommandProcessor<TestCommand>(db.col, bus, silentLogger, handle, { schema: testCommandSchema })
  return { bus, processor }
}

describe("CommandProcessor", () => {
  it("runs commands one at a time, in the order they arrive", async () => {
    let release = () => undefined as void
    const held = new Promise<void>((r) => (release = r))
    const log: string[] = []
    const { bus, processor } = await setup(async (c) => {
      log.push(`start ${c.type}`)
      if (c.type === "pause") await held
      log.push(`end ${c.type}`)
      return "ok"
    })
    processor.submit("d1", { type: "pause" }, "owner")
    processor.submit("d2", { type: "resume" }, "owner")
    await new Promise((r) => setTimeout(r, 20))
    expect(processor.status("d2")).toMatchObject({ status: "pending" })
    release()
    await processor.idle()
    expect(log).toEqual(["start pause", "end pause", "start resume", "end resume"])
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

  it("records a command that failed, with its error, and carries on with the next", async () => {
    const { bus, processor } = await setup(async (c) => {
      if (c.type === "pause") throw new Error("broker down")
      return "resumed"
    })
    processor.submit("d1", { type: "pause" }, "owner")
    processor.submit("d2", { type: "resume" }, "owner")
    await processor.idle()
    expect(processor.status("d1")).toMatchObject({ status: "failed", error: "broker down" })
    expect(await db.col.commands.findOne({ _id: "d1" })).toMatchObject({ status: "failed", error: "broker down", processed_at: expect.any(Date) })
    expect(await db.col.audit.findOne({ target: "d1" })).toMatchObject({ action: "command.failed", details: { error: "broker down" } })
    expect(processor.status("d2")).toMatchObject({ status: "done", result: "resumed" })
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
