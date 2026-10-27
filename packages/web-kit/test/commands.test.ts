import { describe, expect, it, vi } from "vitest"
import { createCommands } from "../src/commands"

type Cmd = { type: "pause" } | { type: "seed.schedule"; amount_usd: number; at: string; force?: boolean } | { type: "settings.update"; patch: Record<string, unknown>; expected_version: number }

/** A hand-written schema in zod's safeParse shape. */
const commandSchema = {
  safeParse: (input: unknown) =>
    typeof input === "object" && input !== null && typeof (input as { type?: unknown }).type === "string"
      ? { success: true as const, data: input as Cmd }
      : { success: false as const, error: { issues: [{ path: ["type"], message: "Required" }] } },
}
const settingsSchema = { safeParse: (input: unknown) => ({ success: true as const, data: input as { budget: number } }) }

const setup = ({ seeds = [] as { status: string }[], settings = { settings: { budget: 5 } } as object | null } = {}) => {
  const commands = { insertOne: vi.fn(async () => ({})) }
  const audit = { insertOne: vi.fn(async () => ({})) }
  const seedRuns = { findOne: vi.fn(async (filter: { status: string | { $in: string[] } }) => seeds.find((s) => (typeof filter.status === "string" ? s.status === filter.status : filter.status.$in.includes(s.status))) ?? null) }
  const settingsCol = { findOne: vi.fn(async () => settings) }
  const applySettingsPatch = vi.fn((base: { budget: number }, patch: Record<string, unknown>) => (typeof patch.budget === "number" && patch.budget >= 0 ? { ok: true as const } : { ok: false as const, errors: [`budget must be ≥ 0 (was ${base.budget})`] }))
  const { submitCommand } = createCommands({
    collections: async () => ({ commands, audit, settings: settingsCol, seedRuns }) as never,
    commandSchema,
    settingsSchema,
    applySettingsPatch,
  })
  return { submitCommand, commands, audit }
}

describe("submitCommand", () => {
  it("rejects an invalid command with the schema's messages", async () => {
    const { submitCommand, commands } = setup()
    expect(await submitCommand({}, "owner")).toEqual({ ok: false, error: "type: Required" })
    expect(commands.insertOne).not.toHaveBeenCalled()
  })

  it("queues a valid command and audits it", async () => {
    const { submitCommand, commands, audit } = setup()
    const result = await submitCommand({ type: "pause" }, "owner")
    expect(result.ok).toBe(true)
    expect(commands.insertOne).toHaveBeenCalledWith(expect.objectContaining({ type: "pause", command: { type: "pause" }, status: "pending", created_by: "owner" }))
    expect(audit.insertOne).toHaveBeenCalledWith(expect.objectContaining({ action: "command.requested", actor: "owner", details: { type: "pause", command: { type: "pause" } } }))
  })

  it("refuses a second seed while one is scheduled, and a new one after a done seed unless forced", async () => {
    const seed = { type: "seed.schedule", amount_usd: 2000, at: "2026-10-27T13:45:00Z" }
    expect(await setup({ seeds: [{ status: "scheduled" }] }).submitCommand(seed, "owner")).toEqual({ ok: false, error: "a seed is already scheduled; cancel it first" })
    expect((await setup({ seeds: [{ status: "done" }] }).submitCommand(seed, "owner")).ok).toBe(false)
    expect((await setup({ seeds: [{ status: "done" }] }).submitCommand({ ...seed, force: true }, "owner")).ok).toBe(true)
  })

  it("checks a settings patch against the stored settings first", async () => {
    expect(await setup({ settings: null }).submitCommand({ type: "settings.update", patch: { budget: 1 }, expected_version: 1 }, "owner")).toEqual({ ok: false, error: "settings not initialized yet (start the engine once)" })
    expect(await setup().submitCommand({ type: "settings.update", patch: { budget: -1 }, expected_version: 1 }, "owner")).toEqual({ ok: false, error: "budget must be ≥ 0 (was 5)" })
    expect((await setup().submitCommand({ type: "settings.update", patch: { budget: 1 }, expected_version: 1 }, "owner")).ok).toBe(true)
  })
})
