import "server-only"
import { randomUUID } from "node:crypto"
import { commandSchema, type Command } from "@mb/stock-core/commands"
import { applySettingsPatch, settingsSchema, type SettingsPatch } from "@mb/stock-core/settings"
import { collections } from "./db"

/**
 * Queues an owner command for the engine. Validated here for fast feedback, re-validated by the
 * engine before it acts. Every command is written to the audit log with what was asked.
 */
export const submitCommand = async (input: unknown, actor: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
  const parsed = commandSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
  const command: Command = parsed.data
  const { commands, audit, settings, seedRuns } = await collections()
  if (command.type === "seed.schedule") {
    // The engine enforces these too; checking here gives the form an immediate answer.
    const active = await seedRuns.findOne({ status: { $in: ["scheduled", "running"] } })
    if (active) return { ok: false, error: `a seed is already ${active.status}; cancel it first` }
    if (!command.force && (await seedRuns.findOne({ status: "done" }))) return { ok: false, error: 'a seed already ran; tick "force a new seed" to run another' }
  }
  if (command.type === "settings.update") {
    // Same validation the engine applies, so a bad form never reaches the queue.
    const current = await settings.findOne({ _id: "current" })
    if (!current) return { ok: false, error: "settings not initialized yet (start the engine once)" }
    const base = settingsSchema.safeParse(current.settings)
    if (!base.success) return { ok: false, error: "stored settings are invalid; check the engine logs" }
    const check = applySettingsPatch(base.data, command.patch as SettingsPatch)
    if (!check.ok) return { ok: false, error: check.errors.join("; ") }
  }
  const id = randomUUID()
  const now = new Date()
  await commands.insertOne({ _id: id, type: command.type, command, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null })
  await audit.insertOne({ _id: randomUUID(), at: now, actor, action: `command.requested`, target: id, details: { type: command.type, command } })
  return { ok: true, id }
}
