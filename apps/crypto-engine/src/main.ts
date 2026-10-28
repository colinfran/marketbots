import { bootstrap } from "@mb/engine-kit/bootstrap"
import { newsMovesJob } from "@mb/history/moves"
import { HistoryStore } from "@mb/history/store"
import { krakenDailyJob, krakenFilesJob, krakenGapJob } from "./history/backfill"
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
import { loadSettings } from "./state/stores"
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
 * Engine entry point: the shared boot order and graceful shutdown (@mb/engine-kit/bootstrap) with
 * crypto's own wiring. After the stream server is up: Kraken market data, the paper wallet, the
 * books, AI, the news engine and the history store; the engine then reconciles with the paper
 * wallet before the trading loops start. Market data stops right after the engine has shut down.
 */

void bootstrap({
  name: "CryptoMarketBot",
  version: ENGINE_VERSION,
  loadEnv,
  secretValues,
  startFields: (env) => ({ workspace: env.KRAKEN_WORKSPACE }),
  connectDatabase,
  EventBus,
  loadSettings,
  Alerts,
  StreamServer,
  assemble: async ({ env, log, db, bus, settings, state, alerts, stream, signal }) => {
    let engine: Engine | null = null
    const rest = new KrakenRest()
    const hub = new MarketHub(rest, bus, log.child({ component: "market" }), () => settings.current.kraken.max_quote_age_seconds)
    await hub.start(settings.current.universe.kraken_symbols, signal)
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

    // The history store (docs/plans/LOCAL-AI.md §6): every closed 1-minute bar, and the news archive.
    const history = env.HISTORY_URL ? new HistoryStore({ url: env.HISTORY_URL, log: log.child({ component: "history" }), col: db.col }) : null
    if (history) {
      hub.onBar((bar) => history.bars.add({ ...bar, source: "kraken" }))
      const backfill = { dir: env.KRAKEN_OHLCVT_DIR, rest, pairs: () => hub.pairs, universe: () => hub.universe }
      history.addJob(krakenFilesJob(backfill))
      history.addJob(krakenGapJob(backfill))
      history.addJob(krakenDailyJob(backfill))
      history.addJob(newsMovesJob("BTC/USD"))
      history.start()
    }

    engine = new Engine({ env, log, db, bus, settings, state, hub, rest, candles, cli, ledger, executor, ai, budget, alerts, stream, wire, history })
    return {
      engine,
      stop: () => {
        hub.stop()
        void history?.stop()
      },
    }
  },
})
