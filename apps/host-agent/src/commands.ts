import type { FanSettings, HostCommand, HostFans, HostOutlet, HostSettings } from "@mb/core/host"
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

/**
 * The owner's commands, as the API takes them (already validated): each is recorded as pending, run
 * after the ones before it, and its outcome kept in the store for the page to poll.
 */
export class HostCommands {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: Pick<HostStore, "addCommand" | "setCommand">,
    private readonly targets: CommandTargets,
    private readonly log: Log,
  ) {}

  /** Queues a command; false if its id is taken. */
  submit(id: string, command: HostCommand, actor: string, now = new Date()): boolean {
    if (!this.store.addCommand({ _id: id, type: command.type, command, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null })) return false
    this.queue = this.queue.then(() => this.run(id, command)).catch((e) => this.log.error("host command not recorded", { type: command.type, error: errorMessage(e) }))
    return true
  }

  /** Settles once every command queued so far has run. */
  idle(): Promise<void> {
    return this.queue
  }

  private async run(id: string, command: HostCommand) {
    this.store.setCommand(id, "processing", null, null)
    try {
      const result = await runHostCommand(command, this.targets)
      this.log.info("host command done", { type: command.type, result })
      this.store.setCommand(id, "done", result, null)
    } catch (e) {
      const error = errorMessage(e).slice(0, 500)
      this.log.warn("host command failed", { type: command.type, error })
      this.store.setCommand(id, "failed", null, error)
    }
  }
}
