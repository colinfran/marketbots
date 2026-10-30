import { HOST_COMMAND_TTL_MS, hostCommandSchema, type FanSettings, type HostCommand, type HostFans, type HostOutlet, type HostSettings } from "@mb/core/host"
import { errorMessage, type Log } from "./log"
import type { HostStore } from "./store"

/** What the owner's commands act on. */
export type CommandTargets = {
  fans: { update(settings: FanSettings): Promise<HostFans> }
  settings: { save(next: HostSettings): Promise<HostSettings> }
  power: { discover(): Promise<HostOutlet[]> }
  /** Called after the settings changed. */
  onSettings(next: HostSettings): void
}

const FAN_APPLIED = {
  curve: (n: number) => `Automatic cooling is on for ${n} fan${n === 1 ? "" : "s"}.`,
  manual: (n: number, pct: number) => `Manual speed ${pct}% is set on ${n} fan${n === 1 ? "" : "s"}.`,
  bios: () => "Every fan is back on BIOS control.",
}

/** Runs one command; its result line, or a throw with the reason it failed. */
export const runHostCommand = async (command: HostCommand, t: CommandTargets): Promise<string> => {
  switch (command.type) {
    case "fans.set": {
      const fans = await t.fans.update({ mode: command.mode, manual_pct: command.manual_pct })
      const applied = FAN_APPLIED[command.mode](fans.fans.length, command.manual_pct)
      return `${applied} ${fans.error ?? "Saved for restarts; the RPMs can take a few seconds to follow."}`
    }
    case "settings.update": {
      const next = await t.settings.save(command.settings)
      t.onSettings(next)
      return "Settings saved."
    }
    case "outlets.discover": {
      const outlets = await t.power.discover()
      return outlets.length ? `Found ${outlets.length}: ${outlets.map((o) => `${o.name} (${o.model})`).join(", ")}.` : "No supported energy-monitoring outlet on the VeSync account."
    }
  }
}

/** Takes and answers the pending commands, oldest first. One that waited past HOST_COMMAND_TTL_MS is rejected unapplied. */
export const drainCommands = async (store: Pick<HostStore, "nextCommand" | "finish">, targets: CommandTargets, log: Log, now = Date.now) => {
  for (let i = 0; i < 10; i++) {
    const next = await store.nextCommand()
    if (!next) return
    const { db, doc } = next
    const parsed = hostCommandSchema.safeParse(doc.command)
    if (!parsed.success) {
      await store.finish(db, doc, "rejected", null, parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "))
      continue
    }
    if (now() - doc.created_at.getTime() > HOST_COMMAND_TTL_MS) {
      await store.finish(db, doc, "rejected", null, "Expired: the server didn't pick it up within 2 minutes. Send it again.")
      continue
    }
    try {
      const result = await runHostCommand(parsed.data, targets)
      log.info("host command done", { type: doc.type, result })
      await store.finish(db, doc, "done", result, null)
    } catch (e) {
      const error = errorMessage(e).slice(0, 500)
      log.warn("host command failed", { type: doc.type, error })
      await store.finish(db, doc, "failed", null, error)
    }
  }
}
