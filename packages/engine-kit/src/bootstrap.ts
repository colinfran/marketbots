import type { AuditDoc, EngineStateDoc, LeaseDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import type { Database } from "./db"
import type { BaseEnv } from "./env"
import { Lease } from "./lease"
import { createLogger, dailyLogFiles, errorMessage, registerSecrets, toStdout, type Fields, type Logger } from "./log"
import { EngineStateStore } from "./state/stores"
import type { StreamServerOptions } from "./stream"

/**
 * Engine entry point, the same for both bots. Startup order matters:
 *   1. env + logger (secrets registered for scrubbing before anything can log them)
 *   2. MongoDB (retried: the container may start before the network is up)
 *   3. single-instance lease, so two engines can never trade the same books or account
 *   4. event bus, settings, state, alerts; stream server (the dashboard can connect while the rest boots)
 *   5. the bot's own wiring (`assemble`): its market data or broker, AI, news engine and the engine
 *   6. signal handlers and the lease keep-alive, then the bot's extra start step and the engine
 *
 * SIGTERM / SIGINT (docker stop, Ctrl+C) shut down gracefully: stop taking new work, let an
 * in-flight cycle finish (up to 20s), flush events, release the lease. A bad environment (or any
 * error before the engine runs) prints one line and exits 1, so Docker restarts the container.
 *
 * With LOG_DIR set, every log line also goes to that day's file there (`dailyLogFiles`), which
 * outlives the container.
 */

/** What the bootstrap needs from the engine. */
export type BootEngine = {
  readonly ready: boolean
  readonly status: string
  start(): Promise<void>
  shutdown(reason: string): Promise<void>
}

/** The shared pieces, handed to the bot's `assemble`. */
export type BootCore<Env, Col, Bus, Settings, Alerts, Stream> = {
  env: Env
  log: Logger
  db: Database<Col>
  bus: Bus
  settings: Settings
  state: EngineStateStore
  alerts: Alerts
  stream: Stream
  /** Aborted when shutdown begins. */
  signal: AbortSignal
}

/** What the bot's `assemble` returns: the engine, and the bot's own steps around it. */
export type BotParts<E> = {
  engine: E
  /** Runs right before the engine starts (stock: the news engine's price layers). */
  start?: () => void
  /** Runs right after the engine has shut down (crypto: market data; stock: the price layers). */
  stop?: () => void
}

type CoreCol = { lease: Collection<LeaseDoc>; engineState: Collection<EngineStateDoc>; audit: Collection<AuditDoc> }
type BootBus = { init(): Promise<void>; stop(): Promise<void> }
type BootStream = { start(): Promise<void>; stop(): Promise<void> }

/**
 * The bot's bindings: its env, its bound classes and loaders, and its own wiring. The properties
 * are listed in boot order (TypeScript infers each one's types from the ones before it).
 */
export type EngineBinding<Env extends BaseEnv, Col extends CoreCol, Bus extends BootBus, Settings, Alerts, Stream extends BootStream, E extends BootEngine> = {
  /** The bot's name in the first log line, e.g. "CryptoMarketBot". */
  name: string
  version: string
  loadEnv: () => Env
  secretValues: (env: Env) => string[]
  /** Extra fields for the first log line (crypto: the paper workspace). */
  startFields?: (env: Env) => Fields
  connectDatabase: (uri: string, dbName: string, log: Logger) => Promise<Database<Col>>
  EventBus: new (col: Col, log: Logger, retentionDays: number) => Bus
  loadSettings: (col: Col, env: Env, log: Logger) => Promise<Settings>
  Alerts: new (col: Col, bus: Bus, log: Logger, webhook: string | null, dashboardUrl: string | null) => Alerts
  StreamServer: new (bus: Bus, log: Logger, opts: StreamServerOptions) => Stream
  /** Wires the bot's market data or broker, AI, news engine and the engine. */
  assemble: (core: BootCore<Env, Col, Bus, Settings, Alerts, Stream>) => Promise<BotParts<E>>
}

/** The process the engine runs in; tests pass a stand-in. */
export type BootHost = Pick<NodeJS.Process, "on" | "exit" | "pid">

export type BootOptions = {
  host?: BootHost
  /** Where log lines go instead of stdout (LOG_DIR's day files still get them). */
  write?: (line: string) => void
}

const run = async <Env extends BaseEnv, Col extends CoreCol, Bus extends BootBus, Settings, Alerts, Stream extends BootStream, E extends BootEngine>(
  b: EngineBinding<Env, Col, Bus, Settings, Alerts, Stream, E>,
  host: BootHost,
  write: (line: string) => void,
  boot: { log?: Logger },
) => {
  const env = b.loadEnv()
  registerSecrets(b.secretValues(env))
  const file = env.LOG_DIR ? dailyLogFiles(env.LOG_DIR) : null
  const out = file
    ? (line: string) => {
        write(line)
        file(line)
      }
    : write
  const log = createLogger(env.LOG_LEVEL, { service: "engine", instance: env.ENGINE_INSTANCE }, out)
  boot.log = log
  log.info(`starting ${b.name} engine`, { version: b.version, node: process.version, ...b.startFields?.(env) })

  const shutdownSignal = new AbortController()
  const db = await b.connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, log)

  const lease = new Lease(db.col, `${env.ENGINE_INSTANCE}:${host.pid}`, log.child({ component: "lease" }))
  await lease.acquire(shutdownSignal.signal)

  const bus = new b.EventBus(db.col, log.child({ component: "events" }), env.EVENT_RETENTION_DAYS)
  await bus.init()
  const settings = await b.loadSettings(db.col, env, log)
  const state = await EngineStateStore.load(db.col)
  const alerts = new b.Alerts(db.col, bus, log.child({ component: "alerts" }), env.DISCORD_WEBHOOK_URL, env.DASHBOARD_URL)

  let engine: E | null = null
  const stream = new b.StreamServer(bus, log.child({ component: "stream" }), {
    host: env.STREAM_HOST,
    port: env.STREAM_PORT,
    secret: env.STREAM_TOKEN_SECRET,
    allowedOrigins: env.STREAM_ALLOWED_ORIGINS,
    trustProxy: env.STREAM_TRUST_PROXY,
    maxClients: env.STREAM_MAX_CLIENTS,
    ready: () => engine?.ready ?? false,
  })
  await stream.start()
  if (!env.STREAM_ALLOWED_ORIGINS.length) log.warn("STREAM_ALLOWED_ORIGINS is empty: any website can open the public stream")

  const bot = await b.assemble({ env, log, db, bus, settings, state, alerts, stream, signal: shutdownSignal.signal })
  engine = bot.engine

  let stopping = false
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return
    stopping = true
    shutdownSignal.abort()
    // Hard deadline: Docker sends SIGKILL after stop_grace_period (30s in compose).
    const deadline = setTimeout(() => host.exit(code || 1), 25_000)
    deadline.unref()
    try {
      await engine?.shutdown(reason)
      bot.stop?.()
      // A pause or kill switch that took effect before the database had it is saved now if it can be.
      if (!(await state.settle(5_000))) log.error("the engine state wasn't saved before stopping")
      await bus.stop()
      await stream.stop()
      await lease.release()
      await db.client.close()
    } catch (error) {
      log.error("error during shutdown", { error: errorMessage(error) })
    }
    log.info("engine stopped", { reason })
    host.exit(code)
  }
  host.on("SIGTERM", () => void shutdown("SIGTERM"))
  host.on("SIGINT", () => void shutdown("SIGINT"))
  host.on("unhandledRejection", (error) => log.error("unhandled rejection", { error: errorMessage(error) }))
  host.on("uncaughtException", (error) => {
    log.error("uncaught exception; shutting down", { error: errorMessage(error), stack: error.stack })
    void shutdown("uncaught exception", 1)
  })
  lease.keepAlive(() => void shutdown("lease lost", 1))

  bot.start?.()
  await engine.start()
  log.info("engine running", { status: engine.status })
}

/** Boots the engine (see the top of this file). Never rejects: a fatal error exits the process with code 1. */
export const bootstrap = async <Env extends BaseEnv, Col extends CoreCol, Bus extends BootBus, Settings, Alerts, Stream extends BootStream, E extends BootEngine>(
  binding: EngineBinding<Env, Col, Bus, Settings, Alerts, Stream, E>,
  { host = process, write = toStdout }: BootOptions = {},
): Promise<void> => {
  const boot: { log?: Logger } = {}
  try {
    await run(binding, host, write, boot)
  } catch (error) {
    // Exit non-zero so Docker restarts us. Before the logger exists (bad env), print plainly.
    if (boot.log) boot.log.error("engine failed to start; exiting", { error: errorMessage(error) })
    else console.error(`[engine] fatal: ${error instanceof Error ? error.message : String(error)}`)
    host.exit(1)
  }
}
