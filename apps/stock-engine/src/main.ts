import { AiRunner } from "@mb/engine-kit/ai/runner"
import { Lease } from "@mb/engine-kit/lease"
import { createLogger, errorMessage, registerSecrets } from "@mb/engine-kit/log"
import { AiBudget } from "./ai/budget"
import { Alerts } from "./alerts"
import { createAlpaca } from "./alpaca/client"
import { MarketStream } from "./alpaca/market-stream"
import { TradeStream } from "./alpaca/trade-stream"
import { EventBus } from "./bus/event-bus"
import { connectDatabase } from "./db/mongo"
import { Engine, ENGINE_VERSION } from "./engine"
import { loadEnv, secretValues, wireEnv } from "./env"
import { PriceCoverage } from "./market/price-layers"
import { LivePrices } from "./market/prices"
import { ScanUniverseStore } from "./market/scan-universe"
import { EngineStateStore, loadSettings } from "./state/stores"
import { StreamServer } from "./stream/server"
import { DEFAULT_USER_AGENT } from "./util/http"
import { CATALOG } from "./wire/catalog"
import { stockLexicon } from "./wire/lexicon"
import { alpacaNewsSpec, moversSpec } from "./wire/sources/alpaca"
import { StockMarketSignals } from "./wire/sources/stock-market"
import { Wire } from "./wire/wire"

/**
 * Engine entry point. Startup order matters:
 *   1. env + logger (secrets registered for scrubbing before anything can log them)
 *   2. MongoDB (retried: the container may start before the network is up)
 *   3. single-instance lease, so two engines can never trade the same account
 *   4. event bus, settings, state; stream server (dashboard can connect while the rest boots)
 *   5. Alpaca (REST + trade updates + market data), then the trading loops
 *
 * SIGTERM / SIGINT (docker stop, Ctrl+C) shut down gracefully: stop taking new work, let an
 * in-flight cycle finish (up to 20s), flush events, release the lease.
 */

const main = async () => {
  const env = loadEnv()
  registerSecrets(secretValues(env))
  const log = createLogger(env.LOG_LEVEL, { service: "engine", instance: env.ENGINE_INSTANCE })
  log.info("starting StockMarketBot engine", { version: ENGINE_VERSION, node: process.version })

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

  const creds = { keyId: env.ALPACA_API_KEY, secret: env.ALPACA_SECRET_KEY, feed: env.ALPACA_DATA_FEED }
  const alpaca = createAlpaca(creds, (h) => engine?.onRestHealth(h))
  const prices = new LivePrices(bus)
  const brokerState = (channel: "trade_updates" | "market_data") => (connected: boolean, reason: string) =>
    connected
      ? bus.emit("broker.connected", { channel }, { summary: `Alpaca ${channel === "trade_updates" ? "trade updates" : "market data"} connected`, level: "debug" })
      : bus.emit("broker.disconnected", { channel, reason }, { summary: `Alpaca ${channel === "trade_updates" ? "trade updates" : "market data"} disconnected (${reason})`, level: "warn" })
  const tradeStream = new TradeStream(creds, log.child({ component: "trade-stream" }), { onUpdate: (u) => engine?.onTradeUpdate(u), onState: brokerState("trade_updates") })
  // Our own market data as a news source: 1-minute bars for the scan universe and what we hold and
  // watch, merged from the free price layers (MASTER_PLAN §3.13), judged against SPY.
  const marketSignals = new StockMarketSignals(alpaca, () => settings.current, log.child({ component: "anomaly" }), () => engine?.sessionOpenAt() ?? null, (symbol, kind) => wire.recordAnomaly(symbol, kind))
  const marketStream = new MarketStream(creds, log.child({ component: "market-stream" }), {
    onTrade: (s, p, t) => {
      prices.onTrade(s, p, t)
      coverage.board.tick("A", s, p, t)
    },
    onQuote: (s, b, a, t) => prices.onQuote(s, b, a, t),
    onState: brokerState("market_data"),
    onBar: (bar) => coverage.board.bar("B", bar.symbol, bar.t, bar.close, bar.volume),
  })
  const universe = new ScanUniverseStore(db.col, alpaca, () => settings.current, log.child({ component: "scan-universe" }))
  const coverage = new PriceCoverage({
    alpaca,
    universe,
    marketStream,
    settings: () => settings.current,
    log,
    finnhubKey: env.FINNHUB_API_KEY ?? undefined,
    sessionOpen: () => engine?.marketOpen() ?? false,
    onBars: (t, bars) => marketSignals.onBars(t, bars),
    onTracked: (symbols) => marketSignals.setTracked(symbols),
  })
  const budget = new AiBudget(db.col, () => settings.current.ai.daily_budget_usd)
  const ai = new AiRunner(budget, log.child({ component: "ai" }), !!env.AI_GATEWAY_API_KEY)

  const wire = new Wire({
    col: db.col,
    bus,
    log: log.child({ component: "wire" }),
    settings: () => settings.current.wire,
    catalog: [...CATALOG, alpacaNewsSpec(alpaca), moversSpec(alpaca, () => settings.current, () => engine?.marketOpen() ?? false), marketSignals.spec(), ...coverage.specs()],
    lexicon: stockLexicon,
    env: wireEnv(env),
    symbols: () => engine?.wireSymbols() ?? { universe: [], held: [], focus: [] },
    // Broker prices first; the other layers fill in for symbols outside the 30-symbol stream.
    price: (symbol) => prices.fresh(symbol, 5 * 60_000) ?? coverage.price(symbol, 5 * 60_000),
    userAgent: env.SEC_USER_AGENT ?? DEFAULT_USER_AGENT,
  })

  engine = new Engine({ env, log, db, bus, settings, state, alpaca, prices, tradeStream, marketStream, ai, budget, alerts, stream, wire, coverage })

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
      coverage.stop()
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

  coverage.start()
  await engine.start()
  log.info("engine running", { status: engine.status })
}

main().catch((error) => {
  // Logger may not exist yet (bad env); print plainly and exit non-zero so Docker restarts us.
  console.error(`[engine] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
