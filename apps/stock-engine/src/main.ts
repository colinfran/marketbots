import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { AiRunner } from "@mb/engine-kit/ai/runner"
import { bootstrap } from "@mb/engine-kit/bootstrap"
import { newsMovesJob } from "@mb/history/moves"
import { HistoryStore } from "@mb/history/store"
import { mongoSearchMeter } from "@mb/engine-kit/state/search-usage"
import { httpClient } from "@mb/engine-kit/util/http"
import { localResearcher } from "@mb/wire/research/local"
import { CORE_INDEX_ETFS } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import { stockBackfillJobs } from "./history/backfill"
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
import { loadSettings } from "./state/stores"
import { StreamServer } from "./stream/server"
import { DEFAULT_USER_AGENT } from "./util/http"
import { CATALOG } from "./wire/catalog"
import { stockLexicon } from "./wire/lexicon"
import { alpacaNewsSpec, moversSpec } from "./wire/sources/alpaca"
import { StockMarketSignals } from "./wire/sources/stock-market"
import { Wire } from "./wire/wire"

/**
 * Engine entry point: the shared boot order and graceful shutdown (@mb/engine-kit/bootstrap) with
 * stock's own wiring. After the stream server is up: Alpaca (REST, trade updates, market data),
 * the news engine's price layers, AI, the news engine and the history store (with its backfills).
 * The price layers start right before the engine and stop right after it has shut down.
 */

void bootstrap({
  name: "StockMarketBot",
  version: ENGINE_VERSION,
  loadEnv,
  secretValues,
  connectDatabase,
  EventBus,
  loadSettings,
  Alerts,
  StreamServer,
  assemble: async ({ env, log, db, bus, settings, state, alerts, stream }) => {
    let engine: Engine | null = null
    const creds = { keyId: env.ALPACA_API_KEY, secret: env.ALPACA_SECRET_KEY, feed: env.ALPACA_DATA_FEED }
    const alpaca = createAlpaca(creds, (h) => engine?.onRestHealth(h))
    const prices = new LivePrices(bus)
    const brokerState = (channel: "trade_updates" | "market_data") => (connected: boolean, reason: string) =>
      connected
        ? bus.emit("broker.connected", { channel }, { summary: `Alpaca ${channel === "trade_updates" ? "trade updates" : "market data"} connected`, level: "debug" })
        : bus.emit("broker.disconnected", { channel, reason }, { summary: `Alpaca ${channel === "trade_updates" ? "trade updates" : "market data"} disconnected (${reason})`, level: "warn" })
    // The history store (docs/plans/LOCAL-AI.md §6): the closed 1-minute bars of the symbols the price
    // board tracks (the scan universe, holdings and watchlist; the stream sends every symbol), and the
    // news archive.
    const history = env.HISTORY_URL ? new HistoryStore({ url: env.HISTORY_URL, log: log.child({ component: "history" }), col: db.col }) : null
    let historySymbols = new Set<string>(["SPY"])
    const tradeStream = new TradeStream(creds, log.child({ component: "trade-stream" }), { onUpdate: (u) => engine?.onTradeUpdate(u), onState: brokerState("trade_updates") })
    // Our own market data as a news source: 1-minute bars for the scan universe and what we hold and
    // watch, merged from the free price layers, judged against SPY.
    const marketSignals = new StockMarketSignals(alpaca, () => settings.current, log.child({ component: "anomaly" }), () => engine?.sessionOpenAt() ?? null, (symbol, kind) => wire.recordAnomaly(symbol, kind))
    const marketStream = new MarketStream(creds, log.child({ component: "market-stream" }), {
      onTrade: (s, p, t) => {
        prices.onTrade(s, p, t)
        coverage.board.tick("A", s, p, t)
      },
      onQuote: (s, b, a, t) => prices.onQuote(s, b, a, t),
      onState: brokerState("market_data"),
      onBar: (bar) => {
        coverage.board.bar("B", bar.symbol, bar.t, bar.close, bar.volume)
        if (history && historySymbols.has(bar.symbol)) history.bars.add({ ...bar, source: creds.feed })
      },
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
      onTracked: (symbols) => {
        marketSignals.setTracked(symbols)
        historySymbols = new Set(["SPY", ...symbols])
      },
    })
    const calls = new AiCallLog(db.col, marketDay)
    const ai = new AiRunner(calls, log.child({ component: "ai" }), {
      localUrl: env.LLM_URL,
      // Research for local/… models: our search service and scraper, read by the local model.
      localResearch: localResearcher({
        request: httpClient(env.SEC_USER_AGENT ?? DEFAULT_USER_AGENT).requestText,
        env: {
          LLM_URL: env.LLM_URL,
          SEARCH_URL: env.SEARCH_URL,
          SCRAPER_URL: env.SCRAPER_URL,
          TAVILY_API_KEY: env.TAVILY_API_KEY,
          EXA_API_KEY: env.EXA_API_KEY,
          BRIGHTDATA_API_KEY: env.BRIGHTDATA_API_KEY,
          BRIGHTDATA_ZONE: env.BRIGHTDATA_ZONE,
        },
        client: "stock",
        log: log.child({ component: "research" }),
        meter: mongoSearchMeter(db.col.searchUsage),
      }),
    })

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

    if (history) {
      const extra = () => [...new Set([...settings.current.universe.benchmarks, ...CORE_INDEX_ETFS, ...(engine?.wireSymbols().held ?? [])])]
      for (const job of stockBackfillJobs({ alpaca, universe: () => universe.symbols, extra })) history.addJob(job)
      history.addJob(newsMovesJob("SPY"))
      history.start()
    }
    engine = new Engine({ env, log, db, bus, settings, state, alpaca, prices, tradeStream, marketStream, ai, calls, alerts, stream, wire, coverage, history })
    return {
      engine,
      start: () => coverage.start(),
      stop: () => {
        coverage.stop()
        void history?.stop()
      },
    }
  },
})
