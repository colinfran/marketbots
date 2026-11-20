#!/usr/bin/env node
/**
 *   mb-env <crypto|stock> <command> [args...]
 *
 * Runs a local dev command (the `dev` scripts) with one bot's variables from the repo's `.env` and
 * `.env.local`, under the names its code reads (./env.mjs). The shell's own variables win, as with
 * Node's --env-file.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { devEnv } from "./env.mjs"

const [bot, ...command] = process.argv.slice(2)
if (!bot || command.length === 0) {
  console.error("usage: mb-env <crypto|stock> <command> [args...]")
  process.exit(2)
}

// Through the shell, which finds the .cmd shims on Windows; so each argument is quoted for it.
const quote = (arg) =>
  /^[\w@+=:,./-]+$/.test(arg) ? arg : process.platform === "win32" ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, "'\\''")}'`
const root = fileURLToPath(new URL("../..", import.meta.url))
const child = spawn(command.map(quote).join(" "), { stdio: "inherit", shell: true, env: { ...devEnv(root, bot), ...process.env } })
// Ctrl+C reaches the child from the terminal too: let it shut down, then exit with its code.
process.on("SIGINT", () => {})
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
