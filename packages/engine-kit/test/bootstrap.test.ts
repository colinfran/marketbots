import { EventEmitter } from "node:events"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { bootstrap, type BootCore, type BootHost } from "../src/bootstrap"
import type { Database } from "../src/db"
import { envFields, parseEnv } from "../src/env"
import type { Logger } from "../src/log"
import type { StreamServerOptions } from "../src/stream"
import { useTestDb } from "./helpers/bot"

const db = useTestDb()
type Col = typeof db.col

const envSchema = z.object({ ...envFields({ dbName: "kit_boot", streamPort: 8799 }), EXTRA: z.string().default("x") })
const testEnv = (extra: Record<string, string> = {}) =>
  parseEnv(envSchema, { MONGODB_URI: "mongodb://boot-test", STREAM_TOKEN_SECRET: "s".repeat(40), ENGINE_INSTANCE: "kit", LOG_LEVEL: "debug", ...extra })

/** A bot whose every piece records when it is made, started and stopped. */
const testBot = (steps: string[]) => {
  const parts: { core?: BootCore<ReturnType<typeof testEnv>, Col, FakeBus, { version: number }, FakeAlerts, FakeStream>; readyBefore?: boolean; stream?: FakeStream } = {}
  class FakeBus {
    constructor(_col: Col, _log: Logger, days: number) {
      steps.push(`bus (${days} days)`)
    }
    async init() {
      // The lease is ours before anything else touches the database.
      steps.push(`bus.init (lease held by ${(await db.col.lease.findOne({ _id: "engine" }))?.holder})`)
    }
    async stop() {
      steps.push("bus.stop")
    }
  }
  class FakeAlerts {
    constructor(_col: Col, _bus: FakeBus, _log: Logger, webhook: string | null, dashboardUrl: string | null) {
      steps.push(`alerts (${webhook}, ${dashboardUrl})`)
    }
  }
  class FakeStream {
    constructor(
      _bus: FakeBus,
      _log: Logger,
      readonly opts: StreamServerOptions,
    ) {
      steps.push(`stream (port ${opts.port})`)
      parts.stream = this
    }
    async start() {
      steps.push("stream.start")
    }
    async stop() {
      steps.push("stream.stop")
    }
  }
  const engine = {
    status: "starting",
    get ready() {
      return engine.status === "running"
    },
    start: async () => {
      steps.push("engine.start")
      engine.status = "running"
    },
    shutdown: async (reason: string) => {
      steps.push(`engine.shutdown (${reason})`)
      engine.status = "stopping"
    },
  }
  const binding = {
    name: "TestBot",
    version: "9.9.9",
    loadEnv: () => {
      steps.push("env")
      return testEnv()
    },
    secretValues: () => {
      steps.push("secrets")
      return []
    },
    startFields: (env: ReturnType<typeof testEnv>) => ({ extra: env.EXTRA }),
    connectDatabase: async (uri: string, dbName: string) => {
      steps.push(`connect (${uri}, ${dbName})`)
      return { client: { close: async () => void steps.push("db.close") }, db: null, col: db.col } as unknown as Database<Col>
    },
    EventBus: FakeBus,
    loadSettings: async () => {
      steps.push("settings")
      return { version: 1 }
    },
    Alerts: FakeAlerts,
    StreamServer: FakeStream,
    assemble: async (core: BootCore<ReturnType<typeof testEnv>, Col, FakeBus, { version: number }, FakeAlerts, FakeStream>) => {
      steps.push(`assemble (state ${core.state.state.status})`)
      parts.core = core
      parts.readyBefore = parts.stream?.opts.ready()
      return { engine, start: () => void steps.push("bot.start"), stop: () => void steps.push("bot.stop") }
    },
  }
  return { binding, engine, parts }
}

const testHost = () => {
  const exits: number[] = []
  const host = Object.assign(new EventEmitter(), { pid: 4242, exit: (code: number) => void exits.push(code) })
  return { host: host as unknown as BootHost & EventEmitter, exits }
}

const logLines = () => {
  const lines: Record<string, unknown>[] = []
  return { lines, write: (line: string) => void lines.push(JSON.parse(line)) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("bootstrap", () => {
  it("boots in the shared order, then shuts down gracefully once on SIGTERM", async () => {
    const steps: string[] = []
    const { binding, engine, parts } = testBot(steps)
    const { host, exits } = testHost()
    const { lines, write } = logLines()
    await bootstrap(binding, { host, write })

    expect(steps).toEqual([
      "env",
      "secrets",
      "connect (mongodb://boot-test, kit_boot)",
      "bus (30 days)",
      "bus.init (lease held by kit:4242)",
      "settings",
      "alerts (null, null)",
      "stream (port 8799)",
      "stream.start",
      "assemble (state running)",
      "bot.start",
      "engine.start",
    ])
    expect(lines.map(({ level, msg }) => `${level} ${msg}`)).toEqual([
      "info starting TestBot engine",
      "info engine lease acquired",
      "warn STREAM_ALLOWED_ORIGINS is empty: any website can open the public stream",
      "info engine running",
    ])
    expect(lines[0]).toEqual({ ts: expect.any(String), level: "info", msg: "starting TestBot engine", service: "engine", instance: "kit", version: "9.9.9", node: process.version, extra: "x" })
    expect(lines[3]).toMatchObject({ status: "running" })
    // The stream reports ready only once the engine is.
    expect(parts.readyBefore).toBe(false)
    expect(parts.stream!.opts).toMatchObject({ host: "0.0.0.0", port: 8799, secret: "s".repeat(40), allowedOrigins: [], trustProxy: false, maxClients: 100 })
    expect(parts.stream!.opts.ready()).toBe(true)
    expect(parts.core!.signal.aborted).toBe(false)

    steps.length = 0
    host.emit("SIGTERM")
    host.emit("SIGINT")
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 5_000, interval: 20 })
    expect(steps).toEqual(["engine.shutdown (SIGTERM)", "bot.stop", "bus.stop", "stream.stop", "db.close"])
    expect(await db.col.lease.findOne({ _id: "engine" })).toBeNull()
    expect(parts.core!.signal.aborted).toBe(true)
    expect(lines.at(-1)).toMatchObject({ level: "info", msg: "engine stopped", reason: "SIGTERM" })
    expect(engine.status).toBe("stopping")
  })

  it("shuts down with exit code 1 after an uncaught exception", async () => {
    const steps: string[] = []
    const { binding } = testBot(steps)
    const { host, exits } = testHost()
    const { lines, write } = logLines()
    await bootstrap(binding, { host, write })
    host.emit("unhandledRejection", new Error("stray"))
    expect(lines.at(-1)).toMatchObject({ level: "error", msg: "unhandled rejection", error: "stray" })
    expect(exits).toEqual([])
    host.emit("uncaughtException", new Error("boom"))
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 5_000, interval: 20 })
    expect(lines.map((l) => l.msg).slice(-2)).toEqual(["uncaught exception; shutting down", "engine stopped"])
    expect(steps.slice(-5)).toEqual(["engine.shutdown (uncaught exception)", "bot.stop", "bus.stop", "stream.stop", "db.close"])
  })

  it("prints one line and exits 1 when the environment is invalid, before touching anything", async () => {
    const steps: string[] = []
    const { binding } = testBot(steps)
    const { host, exits } = testHost()
    const printed: unknown[] = []
    vi.spyOn(console, "error").mockImplementation((line) => void printed.push(line))
    await bootstrap(
      {
        ...binding,
        loadEnv: () => {
          steps.push("env")
          return parseEnv(envSchema, {})
        },
      },
      { host },
    )
    expect(printed).toEqual([expect.stringMatching(/^\[engine\] fatal: Invalid engine environment:\n {2}- MONGODB_URI: /)])
    expect(exits).toEqual([1])
    expect(steps).toEqual(["env"])
  })

  it("logs a startup failure once the logger exists, and exits 1", async () => {
    const { binding } = testBot([])
    const { host, exits } = testHost()
    const { lines, write } = logLines()
    const printed = vi.spyOn(console, "error").mockImplementation(() => {})
    await bootstrap(
      {
        ...binding,
        connectDatabase: async () => {
          throw new Error("could not reach MongoDB")
        },
      },
      { host, write },
    )
    expect(lines.at(-1)).toMatchObject({ level: "error", msg: "engine failed to start; exiting", error: "could not reach MongoDB" })
    expect(printed).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it("with LOG_DIR, also writes every line to that day's file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-boot-logs-"))
    try {
      const { binding } = testBot([])
      const { host, exits } = testHost()
      const { lines, write } = logLines()
      await bootstrap({ ...binding, loadEnv: () => testEnv({ LOG_DIR: dir }) }, { host, write })
      host.emit("SIGTERM")
      await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 5_000, interval: 20 })
      const filed = readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
      expect(filed.map((l) => JSON.parse(l))).toEqual(lines)
      expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(["starting TestBot engine", "engine running", "engine stopped"]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
