import { FAN_CONTROL_ID, Lhm } from "./lhm"

/**
 * The fan watchdog (fans.ts startWatchdog): a detached process the agent heartbeats before every
 * fan write, naming the motherboard headers it owns. If the heartbeats stop for 8 seconds, or the
 * agent exits (the IPC channel closes), it hands those headers back to the BIOS, retrying every
 * second until each one took, then exits. Best effort: it can't help if Windows or
 * LibreHardwareMonitor itself is down, which is why the BIOS's own thermal protection stays on.
 */

const board = new Lhm(process.argv[2] ?? "")
const send = (message: object) => {
  if (process.connected) process.send?.(message, () => undefined)
}

let ids: string[] = []
let lastHeartbeat = Date.now()
let restoring = false
let disconnected = false

const restore = async () => {
  if (restoring) return
  restoring = true
  const failed: string[] = []
  await Promise.all(
    ids.map(async (id) => {
      try {
        await board.setControl(id, null)
      } catch (e) {
        failed.push(id)
        const message = `Fan watchdog could not hand ${id} back to the BIOS: ${(e as Error).message}`
        console.error(message)
        send({ error: message })
      }
    }),
  )
  ids = failed
  restoring = false
  if (disconnected && !ids.length) process.exit(0)
}

process.on("message", (m: { type?: string; ids?: unknown; sequence?: number }) => {
  if (m.type !== "heartbeat" || !Array.isArray(m.ids) || restoring) return
  if (!m.ids.every((id) => typeof id === "string" && FAN_CONTROL_ID.test(id))) return
  ids = [...new Set(m.ids as string[])]
  lastHeartbeat = Date.now()
  send({ ack: m.sequence })
})

process.on("disconnect", () => {
  disconnected = true
  void restore()
})

setInterval(() => {
  if (disconnected || Date.now() - lastHeartbeat > 8_000) void restore()
}, 1_000)
