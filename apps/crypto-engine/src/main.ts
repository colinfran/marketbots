import { Lease } from "@mb/engine-kit/lease"
import { createLogger, errorMessage, registerSecrets } from "@mb/engine-kit/log"
import { AiBudget } from "./ai/budget"
import { AiRunner } from "./ai/runner"
import { Alerts } from "./alerts"
import { EventBus } from "./bus/event-bus"
import { connectDatabase } from "./db/mongo"
import { Engine, ENGINE_VERSION } from "./engine"
import { loadEnv, secretValues, wireEnv } from "./env"
import { Executor } from "./execution/executor"
import { PaperWalletExecution } from "./execution/paper-wallet"
import { CandleCache } from "./market/candles"
import { MarketHub } from "./market/hub"
import { Ledger } from "./portfolio/ledger"
import { EngineStateStore, loadSettings } from "./state/stores"
import { StreamServer } from "./stream/server"
import { DEFAULT_USER_AGENT } from "./util/http"
import { KrakenCli } from "./venues/kraken/cli"
import { KrakenRest } from "./venues/kraken/rest"
import { CATALOG } from "./wire/catalog"
import { cryptoLexicon } from "./wire/lexicon"
import { CoinbasePremium } from "./wire/sources/coinbase-ws"
import { KrakenMarketSignals } from "./wire/sources/kraken-market"
import { Wire } from "./wire/wire"

/**
 * Engine entry point. Startup order matters:
 *   1. env + logger (secrets registered for scrubbing before anything can log them)
 *   2. MongoDB (retried: the container may start before the network is up)
 *   3. single-instance lease, so two engines can never trade the same books
 *   4. event bus, settings, state; stream server (dashboard can connect while the rest boots)
 *   5. Kraken market data, paper wallet, reconciliation, then the trading loops
 *
 * SIGTERM / SIGINT (docker stop, Ctrl+C) shut down gracefully: stop taking new work, let an
 * in-flight cycle finish (up to 20s), flush events, release the lease.
 */

const main = async () => {
  const env = loadEnv()
  registerSecrets(secretValues(env))
  const log = createLogger(env.LOG_LEVEL, { service: "engine", instance: env.ENGINE_INSTANCE })
  log.info("starting CryptoMarketBot engine", { version: ENGINE_VERSION, node: process.version, workspace: env.KRAKEN_WORKSPACE })

  const shutdownSignal = new AbortController()
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, log)

  const lease = new Lease(db.col, `${env.ENGINE_INSTANCE}:${process.pid}`, log.child({ component: "lease" }))
  await lease.acquire(shutdownSignal.signal)

  const bus = new EventBus(db.col, log.child({ component: "events" }), env.EVENT_RETENTION_DAYS)
  await bus.init()
  const settings = await loadSettings(db.col, env, log)
  const state = await EngineStateStore.load(db.col)
  const alerts = new Alerts(db.col, bus, log.child({ component: "alerts" }), env.DISCORD_WEBHOOK_URL, env.DASHBOARD_URL)

  let engine: Engine | null = null
  const stream = new StreamServer(bus, log.child({ component: "stream" }), {
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

  const rest = new KrakenRest()
  const hub = new MarketHub(rest, bus, log.child({ component: "market" }), () => settings.current.kraken.max_quote_age_seconds)
  await hub.start(settings.current.universe.kraken_symbols, shutdownSignal.signal)
  const candles = new CandleCache(rest, () => hub.pairs)
  const cli = new KrakenCli(env.KRAKEN_CLI_PATH, env.KRAKEN_WORKSPACE, env.KRAKEN_CLI_TIMEOUT_MS, log.child({ component: "kraken-cli" }))
  const ledger = new Ledger(db.col, bus)
  const executor = new Executor(db.col, ledger, new PaperWalletExecution(cli, hub), bus, log.child({ component: "executor" }))
  const budget = new AiBudget(db.col, () => settings.current.ai.daily_budget_usd)
  const ai = new AiRunner(budget, log.child({ component: "ai" }), !!env.AI_GATEWAY_API_KEY)

  // Our own market data as a news source: price/volume anomalies and stablecoin depegs.
  const marketSignals = new KrakenMarketSignals(hub, () => settings.current, log.child({ component: "anomaly" }), (symbol, kind) => wire.recordAnomaly(symbol, kind))
  // Coinbase's ticker against Kraken's live mid: the Coinbase premium.
  const coinbasePremium = new CoinbasePremium(
    (symbol) => {
      const q = hub.quote(symbol)
      return q && q.ageS <= 30 ? q.mid : null
    },
    () => settings.current,
    log.child({ component: "coinbase-ws" }),
  )
  const wire = new Wire({
    col: db.col,
    bus,
    log: log.child({ component: "wire" }),
    settings: () => settings.current.wire,
    catalog: [...CATALOG, marketSignals.spec(), coinbasePremium.spec()],
    lexicon: cryptoLexicon,
    env: wireEnv(env),
    symbols: () => engine?.wireSymbols() ?? { universe: hub.universe, held: [], focus: [] },
    price: (symbol) => hub.quote(symbol)?.mid ?? null,
    userAgent: env.SEC_USER_AGENT ?? DEFAULT_USER_AGENT,
  })

  engine = new Engine({ env, log, db, bus, settings, state, hub, rest, candles, cli, ledger, executor, ai, budget, alerts, stream, wire })

  let stopping = false
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return
    stopping = true
    shutdownSignal.abort()
    // Hard deadline: Docker sends SIGKILL after stop_grace_period (30s in compose).
    const deadline = setTimeout(() => process.exit(code || 1), 25_000)
    deadline.unref()
    try {
      await engine?.shutdown(reason)
      hub.stop()
      await bus.stop()
      await stream.stop()
      await lease.release()
      await db.client.close()
    } catch (error) {
      log.error("error during shutdown", { error: errorMessage(error) })
    }
    log.info("engine stopped", { reason })
    process.exit(code)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error: errorMessage(error) }))
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception; shutting down", { error: errorMessage(error), stack: error.stack })
    void shutdown("uncaught exception", 1)
  })
  lease.keepAlive(() => void shutdown("lease lost", 1))

  await engine.start()
  log.info("engine running", { status: engine.status })
}

main().catch((error) => {
  // Logger may not exist yet (bad env); print plainly and exit non-zero so Docker restarts us.
  console.error(`[engine] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
