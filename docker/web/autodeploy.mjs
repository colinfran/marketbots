// Deploys the dashboards when main gets a new commit on the server (docs/SERVER.md §8). The repo's
// post-commit and post-merge hooks (.githooks/) start the on-demand task "\marketbots\Web deploy"
// (install-autodeploy.ps1), which runs this without a window; the hook returns at once, so a commit
// never waits for a build. By hand: Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Web deploy',
// or `node docker/web/autodeploy.mjs` (prints its log). `--force` rebuilds even when main is already
// deployed (after changing a build argument in .env, say NEXT_PUBLIC_DISPLAY_TIMEZONE).
//
// It deploys main's committed tree, never the working tree (which may hold work in progress): the
// commit is fetched from this repo into a clean clone beside it, and each dashboard is built and
// started from there: `docker compose up -d --build <app>`, with the live .env. The web image copies
// only its app and the packages it uses (docker/web/Dockerfile), so for a commit that doesn't touch an
// app every layer is cached, the image stays the same and compose leaves its container running: a
// stock change never restarts crypto-web. A failed build leaves the running container as it was and
// is reported to the bot's Discord channel; the next commit, or running the task again, retries. The
// engines are never deployed here (AGENTS.md: by name, between agent episodes).
//
// Its log: logs/autodeploy/<UTC date>.log in the repo (git-ignored); the last deployed commit:
// logs/autodeploy/state.json. No dependencies: Node's own modules, git and docker on PATH.

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENV_FILE = join(REPO, ".env")
const BRANCH = "main"
const CHECKOUT = process.env.AUTODEPLOY_CHECKOUT || resolve(REPO, "..", "marketbots-deploy")
const LOG_DIR = join(REPO, "logs", "autodeploy")
const STATE_FILE = join(LOG_DIR, "state.json")
const LOCK_FILE = join(LOG_DIR, "deploy.lock")
/** Each dashboard, and the .env variable that holds its bot's Discord webhook. */
const APPS = [
  { service: "crypto-web", webhook: "CRYPTO_DISCORD_WEBHOOK_URL", bot: "CryptoMarketBot" },
  { service: "stock-web", webhook: "STOCK_DISCORD_WEBHOOK_URL", bot: "StockMarketBot" },
]

mkdirSync(LOG_DIR, { recursive: true })

const log = (msg, fields = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), msg, ...fields })
  console.log(line)
  try {
    appendFileSync(join(LOG_DIR, `${line.slice(7, 17)}.log`), `${line}\n`)
  } catch {}
}

/** Runs a command; resolves with its exit code and the tail of its output (never throws). */
const run = (cmd, args, { cwd = REPO, timeoutMs = 60_000 } = {}) =>
  new Promise((done) => {
    let out = ""
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    const keep = (chunk) => (out = (out + chunk).slice(-8_000))
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      done({ code: -1, out: `${out}\n${e.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, out })
    })
  })

const git = async (dir, args, timeoutMs = 300_000) => {
  const r = await run("git", ["-C", dir, ...args], { timeoutMs })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(-500)}`)
  return r.out.trim()
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"))
  } catch {
    return { deployed: null }
  }
}

/** One value from the live .env, without loading the file into this process's environment. */
const envValue = (name) => {
  try {
    const line = readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .findLast((l) => l.startsWith(`${name}=`))
    return (line?.slice(name.length + 1).trim() ?? "").replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1")
  } catch {
    return ""
  }
}

const notify = async (app, content) => {
  const url = envValue(app.webhook)
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) return
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: `${app.bot} deploy`, content: content.slice(0, 1_900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => log("discord alert failed", { error: e.message }))
}

/** One deploy at a time: a run started while another builds waits for it (the task queues them too). */
const lock = async () => {
  for (;;) {
    try {
      writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" })
      return () => rmSync(LOCK_FILE, { force: true })
    } catch {
      // A lock left by a run that died (older than 40 minutes) is taken over.
      if (Date.now() - statSync(LOCK_FILE, { throwIfNoEntry: false })?.mtimeMs > 40 * 60_000) rmSync(LOCK_FILE, { force: true })
      else await new Promise((r) => setTimeout(r, 5_000))
    }
  }
}

/** The clean clone at `sha`, fetched from this repo: checked out detached, nothing else in it. */
const checkout = async (sha) => {
  if (!existsSync(join(CHECKOUT, ".git"))) {
    // LF everywhere (AGENTS.md rule 5): Git for Windows' system config says autocrlf=true.
    const clone = await run("git", ["clone", "--quiet", "--no-checkout", "-c", "core.autocrlf=false", REPO, CHECKOUT], { timeoutMs: 600_000 })
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.out.slice(-500)}`)
  }
  await git(CHECKOUT, ["config", "core.autocrlf", "false"])
  await git(CHECKOUT, ["fetch", "--quiet", REPO, BRANCH])
  await git(CHECKOUT, ["checkout", "--quiet", "--force", "--detach", sha])
  await git(CHECKOUT, ["clean", "-fdxq"])
}

/** Builds and starts one dashboard from the clean clone; compose keeps the container if its image didn't change. */
const deployApp = async (app) => {
  const args = ["compose", "--project-directory", CHECKOUT, "-f", join(CHECKOUT, "compose.yml"), "--env-file", ENV_FILE, "up", "-d", "--build", "--no-deps", app.service]
  const started = Date.now()
  const r = await run("docker", args, { cwd: CHECKOUT, timeoutMs: 30 * 60_000 })
  return { ok: r.code === 0, recreated: /\bRecreated?\b|\bCreated\b/.test(r.out), seconds: Math.round((Date.now() - started) / 1000), out: r.out }
}

const main = async () => {
  const unlock = await lock()
  try {
    // Read after taking the lock: a run queued behind another deploys whatever main is by then.
    const sha = await git(REPO, ["rev-parse", `refs/heads/${BRANCH}`])
    const state = readState()
    if (sha === state.deployed && !process.argv.includes("--force")) {
      log("main already deployed", { sha: sha.slice(0, 7) })
      return
    }
    if ((await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 })).code !== 0) {
      log("docker isn't running; nothing deployed", { sha: sha.slice(0, 7) })
      process.exitCode = 1
      return
    }
    log("deploying", { sha: sha.slice(0, 7), from: state.deployed?.slice(0, 7) ?? null })
    await checkout(sha)
    const failed = []
    if (existsSync(join(CHECKOUT, "docker", "web", "Dockerfile"))) {
      for (const app of APPS) {
        const r = await deployApp(app)
        if (r.ok) log(r.recreated ? "deployed" : "unchanged", { app: app.service, sha: sha.slice(0, 7), seconds: r.seconds })
        else {
          log("deploy failed", { app: app.service, sha: sha.slice(0, 7), out: r.out.slice(-2_000) })
          failed.push({ app, out: r.out })
        }
      }
    } else log("no web image at this commit; nothing to deploy", { sha: sha.slice(0, 7) })
    if (!failed.length) {
      writeFileSync(STATE_FILE, `${JSON.stringify({ deployed: sha, deployed_at: new Date().toISOString() }, null, 2)}\n`)
      return
    }
    process.exitCode = 1
    for (const { app, out } of failed) {
      await notify(app, `**${app.service} deploy failed** for ${sha.slice(0, 7)}; the running version stays up.\n\`\`\`\n${out.slice(-1_400)}\n\`\`\`\nLog: logs/autodeploy/ on the server. The next commit on main, or running the Web deploy task again, retries.`)
    }
  } finally {
    unlock()
  }
}

await main().catch(async (e) => {
  // Nothing was built (the checkout failed, say): both bots' channels hear about it.
  log("deploy failed", { error: e.message })
  process.exitCode = 1
  for (const app of APPS) await notify(app, `**Dashboard deploy failed** before building: ${e.message.slice(0, 1_200)}\nThe running versions stay up. Log: logs/autodeploy/ on the server.`)
})
