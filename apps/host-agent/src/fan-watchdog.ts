import { FAN_CONTROL_ID, Lhm } from "./lhm"
import { log, logToFile } from "./log"

/**
 * The fan watchdog (fans.ts startWatchdog): a detached process the agent heartbeats before every
 * fan write, naming the motherboard headers it owns. If the heartbeats stop for 8 seconds, or the
 * agent exits (the IPC channel closes), it hands those headers back to the BIOS, retrying every
 * second until each one took, then exits. Best effort: it can't help if Windows or
 * LibreHardwareMonitor itself is down, which is why the BIOS's own thermal protection stays on.
 *
 * It has no stdio: it writes to the agent's log file (argv[3]) and, while the agent is there,
 * reports failures to it. A header that keeps failing is reported once, not every second.
 */

const [connectionFile = "", logDir] = process.argv.slice(2)
if (logDir) logToFile(logDir)
const board = new Lhm(connectionFile)
const send = (message: object) => {
  if (process.connected) process.send?.(message, () => undefined)
}

let ids: string[] = []
let lastHeartbeat = Date.now()
let restoring = false
let disconnected = false
/** Headers whose last hand-back failed, already reported. */
const failing = new Set<string>()

const restore = async () => {
  if (restoring) return
  restoring = true
  const failed: string[] = []
  await Promise.all(
    ids.map(async (id) => {
      try {
        await board.setControl(id, null)
        failing.delete(id)
      } catch (e) {
        failed.push(id)
        if (failing.has(id)) return
        failing.add(id)
        const message = `Fan watchdog could not hand ${id} back to the BIOS (retrying every second): ${(e as Error).message}`
        log.error("fan watchdog", { error: message })
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
  log.info("fan watchdog: the agent is gone; handing its fans back to the BIOS", { headers: ids.length })
  void restore()
})

setInterval(() => {
  if (disconnected || Date.now() - lastHeartbeat > 8_000) void restore()
}, 1_000)
