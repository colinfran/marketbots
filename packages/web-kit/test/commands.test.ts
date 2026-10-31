import { describe, expect, it, vi } from "vitest"
import { createCommands } from "../src/commands"

type Cmd = { type: "pause" } | { type: "settings.update"; patch: Record<string, unknown>; expected_version: number }

/** A hand-written schema in zod's safeParse shape. */
const commandSchema = {
  safeParse: (input: unknown) =>
    typeof input === "object" && input !== null && typeof (input as { type?: unknown }).type === "string"
      ? { success: true as const, data: input as Cmd }
      : { success: false as const, error: { issues: [{ path: ["type"], message: "Required" }] } },
}
const settingsSchema = { safeParse: (input: unknown) => ({ success: true as const, data: input as { budget: number } }) }

const SECRET = "s".repeat(40)
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * The library on fake collections and a fake engine: `answer` is the engine's reply to each call
 * (rejecting: unreachable), and without one the engine isn't set up at all.
 */
const setup = ({ settings = { settings: { budget: 5 } } as object | null, answer = null as ((init: RequestInit) => Response | Promise<Response>) | null } = {}) => {
  const commands = { insertOne: vi.fn(async () => ({})) }
  const audit = { insertOne: vi.fn(async () => ({})) }
  const settingsCol = { findOne: vi.fn(async () => settings) }
  const applySettingsPatch = vi.fn((base: { budget: number }, patch: Record<string, unknown>) => (typeof patch.budget === "number" && patch.budget >= 0 ? { ok: true as const } : { ok: false as const, errors: [`budget must be ≥ 0 (was ${base.budget})`] }))
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return answer!(init)
  }) as typeof fetch
  const sign = vi.fn((_secret: string, r: { method: string; path: string; body: string }) => ({ "x-mb-signature": `sig:${r.method}:${r.path}:${r.body.length}`, "x-mb-timestamp": "1" }))
  const { submitCommand, getEngineCommand } = createCommands({
    collections: async () => ({ commands, audit, settings: settingsCol }) as never,
    commandSchema,
    settingsSchema,
    applySettingsPatch,
    engine: { streamUrl: () => (answer ? "wss://engine.example.app/v1/stream" : null), secret: () => SECRET, sign },
    fetchFn,
  })
  return { submitCommand, getEngineCommand, commands, audit, calls }
}

describe("submitCommand", () => {
  it("rejects an invalid command with the schema's messages", async () => {
    const { submitCommand, commands, calls } = setup({ answer: () => json({ id: "x" }, 202) })
    expect(await submitCommand({}, "owner")).toEqual({ ok: false, error: "type: Required" })
    expect(commands.insertOne).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("sends a command straight to the engine, signed, and audits it without queueing it", async () => {
    const { submitCommand, commands, audit, calls } = setup({ answer: (init) => json({ id: (JSON.parse(String(init.body)) as { id: string }).id }, 202) })
    const result = await submitCommand({ type: "pause" }, "owner")
    const sent = JSON.parse(String(calls[0].init.body)) as { id: string; actor: string; command: unknown }
    expect(result).toEqual({ ok: true, id: sent.id })
    expect([calls[0].url, calls[0].init.method, sent]).toEqual(["https://engine.example.app/v1/commands", "POST", { id: sent.id, actor: "owner", command: { type: "pause" } }])
    expect(new Headers(calls[0].init.headers).get("x-mb-signature")).toBe(`sig:POST:/v1/commands:${String(calls[0].init.body).length}`)
    expect(commands.insertOne).not.toHaveBeenCalled()
    expect(audit.insertOne).toHaveBeenCalledWith(expect.objectContaining({ action: "command.requested", actor: "owner", target: sent.id, details: { type: "pause", command: { type: "pause" } } }))
  })

  it("queues a command, under the id it tried, when the engine can't be reached or isn't set up", async () => {
    const down = setup({ answer: () => Promise.reject(new Error("connect ECONNREFUSED")) })
    const result = await down.submitCommand({ type: "pause" }, "owner")
    expect(result.ok).toBe(true)
    expect(down.commands.insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: result.ok && result.id, type: "pause", command: { type: "pause" }, status: "pending", created_by: "owner" }))
    expect(down.audit.insertOne).toHaveBeenCalledWith(expect.objectContaining({ action: "command.requested", actor: "owner", details: { type: "pause", command: { type: "pause" } } }))
    const unset = setup()
    expect((await unset.submitCommand({ type: "pause" }, "owner")).ok).toBe(true)
    expect(unset.commands.insertOne).toHaveBeenCalled()
    expect(unset.calls).toEqual([])
  })

  it("shows the engine's refusal instead of queueing the command", async () => {
    const { submitCommand, commands, audit } = setup({ answer: () => json({ error: "type: Invalid input" }, 400) })
    expect(await submitCommand({ type: "pause" }, "owner")).toEqual({ ok: false, error: "The engine refused it: type: Invalid input" })
    expect(commands.insertOne).not.toHaveBeenCalled()
    expect(audit.insertOne).not.toHaveBeenCalled()
  })

  it("checks a settings patch against the stored settings first", async () => {
    expect(await setup({ settings: null }).submitCommand({ type: "settings.update", patch: { budget: 1 }, expected_version: 1 }, "owner")).toEqual({ ok: false, error: "settings not initialized yet (start the engine once)" })
    expect(await setup().submitCommand({ type: "settings.update", patch: { budget: -1 }, expected_version: 1 }, "owner")).toEqual({ ok: false, error: "budget must be ≥ 0 (was 5)" })
    expect((await setup().submitCommand({ type: "settings.update", patch: { budget: 1 }, expected_version: 1 }, "owner")).ok).toBe(true)
  })
})

describe("getEngineCommand", () => {
  it("asks the engine, signed, and reads nothing when it can't be reached", async () => {
    const view = { _id: "c1", type: "pause", status: "done", result: "paused", error: null }
    const { getEngineCommand, calls } = setup({ answer: () => json(view, 200) })
    expect(await getEngineCommand("c1")).toEqual(view)
    expect([calls[0].url, calls[0].init.method]).toEqual(["https://engine.example.app/v1/commands/c1", "GET"])
    expect(await setup({ answer: () => json({ error: "not found" }, 404) }).getEngineCommand("c2")).toBeNull()
    expect(await setup({ answer: () => Promise.reject(new Error("timeout")) }).getEngineCommand("c3")).toBeNull()
  })
})
