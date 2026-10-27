import { createServer } from "node:http"
import { chromium } from "playwright-core"

/**
 * The headless scraper sidecar (MASTER_PLAN Phase 7): renders pages that need JavaScript for the
 * engines' `headless` news sources (wire/kinds/headless.ts). One container serves both engines.
 *
 *   POST /render { url, wait_for?, timeout_ms?, capture? } → { status, url, html, captured }
 *   GET  /health                                           → { ok, browser, active, queued, … }
 *
 * `wait_for` is a CSS selector to wait for; without one the page gets a short network-idle wait.
 * `capture` lists URL substrings: the page's own responses that match are returned as text, for
 * pages whose table is filled from a JSON call. One browser is reused, with a fresh context per
 * render; at most MAX_CONCURRENT renders run at once and up to MAX_QUEUE wait (beyond that: 503).
 * Each caller (the `X-Client` header, else the engine container's address) may hold at most
 * MAX_QUEUE_PER_CALLER of the waiting places, so one bot can never starve the other.
 * Images, media and fonts are never loaded. The browser is replaced every 6 h once idle, and at
 * once if it dies. The container publishes no port: only the engines reach it, over the compose
 * network.
 */

const PORT = Number(process.env.PORT ?? 8790)
const MAX_CONCURRENT = 3
const MAX_QUEUE = 16
const MAX_QUEUE_PER_CALLER = 8
const RESTART_MS = 6 * 3_600_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60_000
const IDLE_WAIT_MS = 8_000
const MAX_REQUEST_BYTES = 64_000
const MAX_HTML_CHARS = 8_000_000
const MAX_CAPTURED = 20
const SKIPPED = new Set(["image", "media", "font"])

let browser = null
let launching = null
let launchedAt = 0
let userAgent = undefined
let active = 0
const waiting = []
const stats = { renders: 0, failures: 0, restarts: 0, started_at: new Date().toISOString() }

const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, service: "scraper", ...extra }))

const ready = async () => {
  if (browser?.isConnected()) return browser
  launching ??= chromium
    .launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] })
    .then((b) => {
      browser = b
      launchedAt = Date.now()
      // Headless Chromium says "HeadlessChrome" in its User-Agent; pages get the ordinary one.
      userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${b.version()} Safari/537.36`
      b.on("disconnected", () => {
        if (browser === b) browser = null
      })
      log("browser launched", { version: b.version() })
      return b
    })
    .finally(() => {
      launching = null
    })
  return launching
}

/** Replaces a browser older than RESTART_MS, only while nothing is rendering. */
const maybeRestart = () => {
  if (active > 0 || !browser || Date.now() - launchedAt < RESTART_MS) return
  const old = browser
  browser = null
  stats.restarts += 1
  old.close().catch(() => {})
  log("browser restarted (age)")
}
setInterval(maybeRestart, 60_000).unref()

const queuedBy = (caller) => waiting.filter((w) => w.caller === caller).length

/** A render slot, or null when the queue (or this caller's share of it) is full. */
const acquire = (caller) => {
  if (active < MAX_CONCURRENT) {
    active += 1
    return Promise.resolve()
  }
  if (waiting.length >= MAX_QUEUE || queuedBy(caller) >= MAX_QUEUE_PER_CALLER) return null
  return new Promise((resolve) => waiting.push({ caller, resolve }))
}

/** Hands the slot to the next waiting render, or frees it. */
const release = () => {
  const next = waiting.shift()
  if (next) next.resolve()
  else {
    active -= 1
    maybeRestart()
  }
}

const render = async ({ url, wait_for, timeout_ms, capture }) => {
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(timeout_ms) || DEFAULT_TIMEOUT_MS))
  const deadline = Date.now() + timeout
  const left = () => Math.max(1_000, deadline - Date.now())
  const b = await ready()
  const context = await b.newContext({ userAgent, viewport: { width: 1366, height: 900 }, locale: "en-US", timezoneId: "America/New_York" })
  try {
    await context.route("**/*", (route) => (SKIPPED.has(route.request().resourceType()) ? route.abort() : route.continue()))
    const page = await context.newPage()
    const pending = []
    if (capture.length) {
      page.on("response", (res) => {
        if (pending.length >= MAX_CAPTURED || !capture.some((s) => res.url().includes(s))) return
        pending.push(
          res
            .text()
            .then((body) => ({ url: res.url(), status: res.status(), body: body.slice(0, MAX_HTML_CHARS) }))
            .catch(() => null),
        )
      })
    }
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout })
    if (wait_for) await page.waitForSelector(wait_for, { timeout: left() })
    else await page.waitForLoadState("networkidle", { timeout: Math.min(IDLE_WAIT_MS, left()) }).catch(() => {})
    const html = await page.content()
    const captured = (await Promise.all(pending)).filter(Boolean)
    return { status: res?.status() ?? 0, url: page.url(), html: html.slice(0, MAX_HTML_CHARS), captured }
  } finally {
    await context.close().catch(() => {})
  }
}

/** The request body as a render job, or a reason it isn't one. */
const parseJob = (raw) => {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { error: "body is not JSON" }
  }
  let url
  try {
    url = new URL(String(body?.url ?? ""))
  } catch {
    return { error: "url is not a URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "only http and https URLs are rendered" }
  const capture = Array.isArray(body.capture) ? body.capture.filter((s) => typeof s === "string" && s.length > 0).slice(0, 10) : []
  return { job: { url: url.toString(), wait_for: typeof body.wait_for === "string" && body.wait_for ? body.wait_for : null, timeout_ms: body.timeout_ms, capture } }
}

/** Who is asking: the X-Client header (e.g. "crypto", "stock"), else the caller's address. */
const callerOf = (req) => {
  const header = String(req.headers["x-client"] ?? "").trim().toLowerCase()
  if (/^[a-z0-9_-]{1,32}$/.test(header)) return header
  return req.socket.remoteAddress ?? "unknown"
}

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (req.method === "GET" && req.url === "/health") {
    const by_caller = {}
    for (const w of waiting) by_caller[w.caller] = (by_caller[w.caller] ?? 0) + 1
    return send(200, { ok: true, browser: !!browser?.isConnected(), active, queued: waiting.length, by_caller, ...stats })
  }
  if (req.method !== "POST" || req.url !== "/render") return send(404, { error: "not found" })

  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_REQUEST_BYTES) return send(413, { error: "request too large" })
  }
  const { job, error } = parseJob(raw)
  if (!job) return send(400, { error })

  const caller = callerOf(req)
  const slot = acquire(caller)
  if (!slot) return send(503, { error: `busy: ${waiting.length} renders queued (${queuedBy(caller)} from ${caller})` })
  await slot
  const started = Date.now()
  try {
    const result = await render(job)
    stats.renders += 1
    log("rendered", { caller, host: new URL(job.url).host, status: result.status, ms: Date.now() - started, html: result.html.length, captured: result.captured.length })
    send(200, result)
  } catch (e) {
    stats.failures += 1
    const message = String(e?.message ?? e).split("\n")[0].slice(0, 300)
    log("render failed", { caller, host: new URL(job.url).host, ms: Date.now() - started, error: message })
    send(502, { error: message })
  } finally {
    release()
  }
})

server.listen(PORT, "0.0.0.0", () => log("scraper listening", { port: PORT }))

const shutdown = () => {
  log("shutting down")
  server.close()
  Promise.resolve(browser?.close())
    .catch(() => {})
    .finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
