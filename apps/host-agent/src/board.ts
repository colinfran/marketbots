import { join } from "node:path"
import { Hwmon } from "./hwmon"
import { Lhm, type Board } from "./lhm"

/**
 * The motherboard backend for this OS (Board): LibreHardwareMonitor on Windows, the kernel's hwmon
 * drivers on Linux. `file` is what that backend keeps on disk: LHM's connection file, or the fan
 * modes hwmon saves before it takes a header (shared with the fan watchdog, which hands them back).
 */
export const boardFile = (env: { LHM_CONNECTION_FILE: string; HOST_DATA_DIR: string }) =>
  process.platform === "win32" ? env.LHM_CONNECTION_FILE : join(env.HOST_DATA_DIR, "hwmon-fan-modes.json")

export const createBoard = (file: string): Board => (process.platform === "win32" ? new Lhm(file) : new Hwmon(file))
