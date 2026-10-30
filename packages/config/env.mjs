import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseEnv } from "node:util"

/**
 * The repo's one env file, `.env` at the root (docs/SERVER.md §3), as one bot's local dev process
 * sees it. compose does the same renaming for the containers, in compose.yml.
 */

export const BOTS = ["crypto", "stock"]

/**
 * A bot's view of the file's variables: a shared one keeps its name, the bot's own CRYPTO_X (or
 * STOCK_X) becomes X and wins over a shared X, and the other bot's are left out.
 */
export const scopeEnv = (vars, bot) => {
  if (!BOTS.includes(bot)) throw new Error(`Unknown bot "${bot}": one of ${BOTS.join(", ")}`)
  const own = `${bot.toUpperCase()}_`
  const prefixes = BOTS.map((b) => `${b.toUpperCase()}_`)
  const shared = Object.entries(vars).filter(([k]) => !prefixes.some((p) => k.startsWith(p)))
  const mine = Object.entries(vars)
    .filter(([k]) => k.startsWith(own))
    .map(([k, v]) => [k.slice(own.length), v])
  return Object.fromEntries([...shared, ...mine])
}

/** `.env`, then `.env.local` (git-ignored overrides, which win), in `root`, for one bot. Either may be missing. */
export const devEnv = (root, bot) => {
  const read = (name) => (existsSync(join(root, name)) ? parseEnv(readFileSync(join(root, name), "utf8")) : {})
  return scopeEnv({ ...read(".env"), ...read(".env.local") }, bot)
}
