import type { BaseCommand } from "@mb/core/commands"
import type { EngineStateDoc } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
import type { Collection } from "mongodb"
import type { AlertLevel, AlertOptions } from "../alerts"
import type { EmitMeta } from "../bus"

/**
 * The owner's controls, the same in both bots: pause and resume, the kill switch, settings
 * changes, news replays, and the agent's (a question, a wake-up, resuming its entries). It owns the
 * engine's run status and emits `engine.status` whenever the owner (or the engine's own safety halt)
 * changes it.
 *
 * The engine dispatches the shared commands to `handle` and runs its own (closing a position…)
 * itself. What differs between the bots is injected: how a liquidating kill switch
 * closes positions, and the wording of a few results.
 */

/** The run statuses every bot has; a bot may add its own (crypto: "reconciling"). */
export type BaseRunStatus = "starting" | "running" | "paused" | "halted" | "stopping"

type ControlEvents<S extends string> = Pick<BaseEventDataMap<string, S, string>, "engine.status">

/** The part of the event bus the control plane uses. */
export type ControlEventSink<S extends string> = { emit<T extends keyof ControlEvents<S>>(type: T, data: ControlEvents<S>[T], meta: EmitMeta): unknown }

/** The bot's own words in results and alerts. */
export type ControlWording = {
  /** The pause result: what keeps running while paused. */
  paused: string
  /** The kill switch's result when it doesn't liquidate. */
  halted: string
}

export type ControlPlaneDeps<S extends string, Item extends { title: string; severity: number }> = {
  col: { wireItems: { findOne(filter: { _id: string }): Promise<Item | null> } }
  bus: ControlEventSink<S | BaseRunStatus>
  state: { readonly state: EngineStateDoc; update(fields: Partial<Omit<EngineStateDoc, "_id">>, by: string, action: string, details?: Record<string, unknown>): Promise<void> }
  settings: { readonly version: number; apply(patch: Record<string, unknown>, by: string, expectedVersion: number | null): Promise<{ ok: true; changes: number } | { ok: false; error: string }> }
  alerts: { send(level: AlertLevel, title: string, message: string, opts?: AlertOptions): Promise<void> }
  /** The news engine's trigger policy, for `wire.replay`. */
  policy: { replay(item: Item): Promise<string> }
  /** Closes every position for a liquidating kill switch; returns what it did, one note per position. */
  liquidate: () => Promise<string[]>
  wording: ControlWording
  /** The agent, for `agent.ask`, `agent.review` and `agent.resume_entries` (absent where there is none). */
  agent?: { ask(question: string, by: string): string; review(symbols: string[], by: string): string; resumeEntries(by: string): Promise<string> } | null
}

export class ControlPlane<S extends string, Item extends { title: string; severity: number }> {
  status: S | BaseRunStatus = "starting"

  constructor(private readonly d: ControlPlaneDeps<S, Item>) {}

  /** Started up and controllable (the stream's /readyz). */
  get ready() {
    return this.status === "running" || this.status === "paused" || this.status === "halted"
  }

  /** Takes the run status from the stored engine state and announces it. */
  emitStatus(reason?: string) {
    const s = this.d.state.state
    this.status = s.kill_switch.engaged ? "halted" : s.status
    this.d.bus.emit("engine.status", { status: this.status, kill_switch: s.kill_switch.engaged, reason }, { summary: `Engine ${this.status}${reason ? `: ${reason}` : ""}` })
  }

  /** Halts new orders (the owner, or the engine's own drawdown halt), closing every position if asked. Returns the liquidation notes. */
  async engageKillSwitch(reason: string, by: string, liquidate: boolean) {
    await this.d.state.update({ status: "halted", kill_switch: { engaged: true, reason, at: new Date(), by, liquidate } }, by, "kill_switch.engage", { reason })
    this.emitStatus(reason)
    const notes = liquidate ? await this.d.liquidate() : []
    await this.d.alerts.send("critical", "Kill switch engaged", `${reason}${notes.length ? `\nLiquidation: ${notes.join("; ")}` : ""}`)
    return notes
  }

  /** Runs a command both bots share. Returns the result for the dashboard; throws to fail the command. */
  async handle(command: BaseCommand, by: string): Promise<string> {
    const { state, settings, col, wording } = this.d
    switch (command.type) {
      case "pause":
        await state.update({ status: "paused", pause_reason: command.reason ?? null }, by, "pause")
        this.emitStatus(command.reason ?? "paused from the dashboard")
        return wording.paused
      case "resume":
        if (state.state.kill_switch.engaged) throw new Error("the kill switch is engaged; release it first")
        await state.update({ status: "running", pause_reason: null }, by, "resume")
        this.emitStatus("resumed from the dashboard")
        return "running"
      case "kill_switch.engage": {
        const notes = await this.engageKillSwitch(command.reason, by, command.liquidate)
        return command.liquidate ? `halted and liquidated: ${notes.join("; ") || "no positions"}` : wording.halted
      }
      case "kill_switch.release":
        // Releasing never resumes trading by itself: the owner resumes explicitly.
        await state.update({ status: "paused", kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false } }, by, "kill_switch.release")
        this.emitStatus("kill switch released; paused until resumed")
        return "kill switch released; engine paused until you resume"
      case "settings.update": {
        const res = await settings.apply(command.patch, by, command.expected_version)
        if (!res.ok) throw new Error(res.error)
        return res.changes ? `${res.changes} setting${res.changes > 1 ? "s" : ""} updated (v${settings.version})` : "no changes"
      }
      case "wire.replay": {
        const item = await col.wireItems.findOne({ _id: command.item_id })
        if (!item) throw new Error("no wire item with that id")
        return `${item.title.slice(0, 120)} (severity ${item.severity}): ${await this.d.policy.replay(item)}`
      }
      case "agent.ask":
        if (!this.d.agent) throw new Error("this engine has no agent")
        return this.d.agent.ask(command.question, by)
      case "agent.review":
        if (!this.d.agent) throw new Error("this engine has no agent")
        if (state.state.status !== "running" || state.state.kill_switch.engaged) throw new Error(`engine is ${this.status}`)
        return this.d.agent.review(command.symbols ?? [], by)
      case "agent.resume_entries":
        if (!this.d.agent) throw new Error("this engine has no agent")
        return this.d.agent.resumeEntries(by)
    }
  }
}
