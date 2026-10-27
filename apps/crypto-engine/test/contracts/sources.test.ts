import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { silentLogger } from "../../src/log"
import { CATALOG } from "../../src/wire/catalog"
import type { WireFetch } from "../../src/wire/fetch"
import { diffEntries } from "../../src/wire/kinds/diff"
import { parseFeed } from "../../src/wire/kinds/rss"
import { parseStatuspage } from "../../src/wire/kinds/statuspage"
import { parseTelegram } from "../../src/wire/kinds/telegram"
import { MetricWatcher, type MetricRule, type Reading } from "../../src/wire/metrics"
import { apewisdomItems, coinbaseRank, coingeckoItems, fngItems, messageRate, pageviewRatio, stocktwitsRateItems, stocktwitsTrendingItems } from "../../src/wire/sources/attention"
import { btcFeeItems, ethGasItems } from "../../src/wire/sources/chain"
import { chainReadings, stableItems, stableReadings, tvlItems } from "../../src/wire/sources/defillama"
import { coinalyzeFunding, coinalyzeLiquidations, coinalyzeSymbols, deribitFundingAnnualPct, hyperliquidReadings, krakenFuturesReadings, latestDvol, perpItems } from "../../src/wire/sources/derivatives"
import { blsFigures, fredValues } from "../../src/wire/sources/macro-actuals"
import { kalshiMarkets, polymarketMarkets } from "../../src/wire/sources/odds"
import type { RawItem, SourceContext, SourceSpec, SymbolSets } from "../../src/wire/types"
import { checkNoOrphans, matchJson } from "./snapshot"

/**
 * Parsed items for every saved source payload in test/fixtures/wire. Where a fixture belongs to a
 * catalog entry, that entry's own parser runs (rss/telegram + `refine`, statuspage, json `map`,
 * diff `entries` + `describe`, html `mapHtml`); otherwise the exported source function its poller
 * calls. Sources that watch a metric get a recording MetricWatcher: on a fresh watcher the first
 * reading is only a baseline (no items), so the snapshot also lists every reading the parser
 * extracted (key, value, time, rules).
 *
 * The universe is the default ten plus the Korean-listed coins the Korea tests use, so the Upbit
 * and Bithumb rows reach the output too.
 */

const DIR = join(__dirname, "..", "fixtures", "wire")
const text = (name: string) => readFileSync(join(DIR, name), "utf8")
const json = (name: string) => JSON.parse(text(name))

/** The time the wire tests use; every parser gets it, and Date is pinned to it as well. */
const NOW = new Date("2026-10-27T12:00:00Z")
const DEFAULT_UNIVERSE = DEFAULT_SETTINGS.universe.kraken_symbols
const KOREAN = ["INIT/USD", "EGLD/USD", "FET/USD", "XAI/USD", "CAMP/USD", "ZK/USD", "AXIS/USD", "CTR/USD", "GAS/USD", "CSPR/USD", "XEC/USD"]
const SYMBOLS: SymbolSets = { universe: [...DEFAULT_UNIVERSE, ...KOREAN], held: ["BTC/USD"], focus: ["SOL/USD"] }
const BASES = new Map(SYMBOLS.universe.map((s) => [s.split("/")[0], s]))

const ctx = {
  fetch: {} as unknown as WireFetch,
  log: silentLogger,
  env: {},
  symbols: () => SYMBOLS,
  now: () => NOW,
  settings: () => DEFAULT_SETTINGS.wire,
} satisfies SourceContext

const spec = (id: string): SourceSpec => {
  const s = CATALOG.find((x) => x.id === id)
  if (!s) throw new Error(`no catalog entry ${id}`)
  return s
}

/** A MetricWatcher that records every reading it is given. */
const recordingWatcher = () => {
  const watcher = new MetricWatcher()
  const rules: Record<string, MetricRule> = {}
  const labels = new Map<string, string>()
  const label = (r: MetricRule) => {
    const key = JSON.stringify(r)
    let l = labels.get(key)
    if (!l) {
      l = r.id in rules ? `${r.id}#${labels.size}` : r.id
      labels.set(key, l)
      rules[l] = r
    }
    return l
  }
  const readings: unknown[] = []
  const observe = watcher.observe.bind(watcher)
  const backfill = watcher.backfill.bind(watcher)
  watcher.observe = (key: string, value: number, at: number, rs: MetricRule[]) => {
    readings.push({ key, value, at: new Date(at), rules: rs.map(label) })
    return observe(key, value, at, rs)
  }
  watcher.backfill = (key: string, points: Reading[], rs: MetricRule[]) => {
    readings.push({ key, backfill: points.map((p) => ({ value: p.value, at: new Date(p.at) })), rules: rs.map(label) })
    return backfill(key, points, rs)
  }
  return { watcher, observations: () => ({ readings, rules }) }
}

const watched = <T>(run: (w: MetricWatcher) => T) => {
  const { watcher, observations } = recordingWatcher()
  const output = run(watcher)
  return { output, observations: observations() }
}

/** An rss catalog entry: the feed parser, then the entry's `refine` when it has one. */
const rssSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "rss") throw new Error(`${id} is not an rss entry`)
  const parsed = parseFeed(text(name))
  return s.refine ? { parser: `parseFeed + ${id}.refine`, parsed, output: s.refine(parsed, ctx) } : { parser: `parseFeed (${id})`, output: parsed }
}

/** A telegram catalog entry: the channel preview parser, then `refine` when it has one. */
const telegramSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "telegram" || !s.channel) throw new Error(`${id} is not a telegram entry`)
  const parsed = parseTelegram(text(name), s.channel)
  return s.refine ? { parser: `parseTelegram + ${id}.refine`, parsed, output: s.refine(parsed, ctx) } : { parser: `parseTelegram (${id})`, output: parsed }
}

/** A json catalog entry's `map`. */
const jsonSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "json" || !s.map) throw new Error(`${id} is not a json entry`)
  return { parser: `${id}.map`, output: s.map(json(name), ctx) }
}

/** A diff catalog entry: its keyed entries, and what `describe` says when every entry appears (from an empty baseline) or disappears (to an empty list). */
const diffSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "diff" || !s.entries || !s.describe) throw new Error(`${id} is not a diff entry`)
  const entries = s.entries(json(name))
  const describe = (before: Map<string, string>, after: Map<string, string>) =>
    diffEntries(before, after)
      .map((c) => s.describe!(c, ctx))
      .filter((i): i is RawItem => i !== null)
  return { parser: `${id}.entries, then ${id}.describe for each entry as added and as removed`, entries, added: describe(new Map(), entries), removed: describe(entries, new Map()) }
}

const statuspageSpec = (id: string, name: string) => {
  if (spec(id).kind !== "statuspage") throw new Error(`${id} is not a statuspage entry`)
  return { parser: `parseStatuspage (${id})`, output: parseStatuspage(json(name), id, NOW) }
}

const PERP_VENUE = { id: "hyperliquid", label: "Hyperliquid", url: () => "https://app.hyperliquid.xyz" }

type Parsed = Record<string, unknown> & { parser: string }

const PARSERS: Record<string, () => Parsed> = {
  "apewisdom.json": () => ({ parser: "apewisdomItems (apewisdom), fresh watcher", ...watched((w) => apewisdomItems(json("apewisdom.json"), w, ctx)) }),
  "appstore-finance.json": () => ({ parser: "coinbaseRank (appstore)", output: coinbaseRank(json("appstore-finance.json")) }),
  "appstore-top.json": () => ({ parser: "coinbaseRank (appstore)", output: coinbaseRank(json("appstore-top.json")) }),
  "blockworks.xml": () => rssSpec("rss:blockworks", "blockworks.xml"),
  "blog-kraken.xml": () => rssSpec("blog:kraken", "blog-kraken.xml"),
  "bls.json": () => {
    const body = json("bls.json")
    const months = [{ year: 2026, month: 8 }, { year: 2026, month: 9 }, { year: 2026, month: 10 }]
    return { parser: "blsFigures (macro_actuals) for cpi and jobs, 2026-08 to 2026-10", output: months.map((ref) => ({ ref, cpi: blsFigures("cpi", body, ref), jobs: blsFigures("jobs", body, ref) })) }
  },
  "cb-boe.xml": () => rssSpec("cb:boe", "cb-boe.xml"),
  "coinalyze-funding.json": () => {
    const bySymbol = coinalyzeBySymbol()
    return { parser: "coinalyzeFunding (coinalyze), symbols from coinalyze-markets.json", by_symbol: bySymbol, output: coinalyzeFunding(json("coinalyze-funding.json"), bySymbol) }
  },
  "coinalyze-liq.json": () => {
    const bySymbol = coinalyzeBySymbol()
    return { parser: "coinalyzeLiquidations (coinalyze) since 1793067000 s, symbols from coinalyze-markets.json", by_symbol: bySymbol, output: coinalyzeLiquidations(json("coinalyze-liq.json"), bySymbol, 1793067000 * 1000) }
  },
  "coinalyze-markets.json": () => ({ parser: "coinalyzeSymbols (coinalyze) for the universe bases", output: coinalyzeSymbols(json("coinalyze-markets.json"), BASES.keys()) }),
  "coinbase-products.json": () => diffSpec("coinbase_products", "coinbase-products.json"),
  "coindesk.xml": () => rssSpec("rss:coindesk", "coindesk.xml"),
  "coingecko-trending.json": () => ({ parser: "coingeckoItems (coingecko), fresh watcher", ...watched((w) => coingeckoItems(json("coingecko-trending.json"), w, ctx)) }),
  "cot.json": () => jsonSpec("cot", "cot.json"),
  "defillama-chains.json": () => ({
    parser: "chainReadings + tvlItems (defillama), fresh watcher",
    readings: chainReadings(json("defillama-chains.json"), BASES),
    ...watched((w) => tvlItems(json("defillama-chains.json"), w, ctx)),
  }),
  "defillama-stables.json": () => ({
    parser: "stableReadings + stableItems (defillama:stables), fresh watcher",
    readings: stableReadings(json("defillama-stables.json")),
    ...watched((w) => stableItems(json("defillama-stables.json"), w, ctx)),
  }),
  "deribit-dvol.json": () => ({ parser: "latestDvol (deribit)", output: latestDvol(json("deribit-dvol.json")) }),
  "deribit-perp.json": () => ({ parser: "deribitFundingAnnualPct (deribit)", output: deribitFundingAnnualPct(json("deribit-perp.json")) }),
  "doj.json": () => jsonSpec("gov:doj", "doj.json"),
  "etherscan-gas.json": () => ({ parser: "ethGasItems (chain:eth_gas), fresh watcher", ...watched((w) => ethGasItems(json("etherscan-gas.json"), w, ctx)) }),
  "fedreg.json": () => jsonSpec("fedreg", "fedreg.json"),
  "ff.json": () => jsonSpec("macro_ff", "ff.json"),
  "finnhub.json": () => jsonSpec("finnhub_crypto", "finnhub.json"),
  "fng.json": () => ({ parser: "fngItems (fng), fresh watcher", ...watched((w) => fngItems(json("fng.json"), w, ctx)) }),
  "fred.json": () => {
    const body = json("fred.json")
    const months = [{ year: 2026, month: 8 }, { year: 2026, month: 9 }, { year: 2026, month: 10 }]
    return { parser: "fredValues (macro_actuals), 2026-08 to 2026-10", output: months.map((ref) => ({ ref, values: fredValues(body, ref) })) }
  },
  "gh-bitcoin.xml": () => rssSpec("gh:bitcoin", "gh-bitcoin.xml"),
  "gh-rippled.xml": () => rssSpec("gh:rippled", "gh-rippled.xml"),
  "hyperliquid.json": () => {
    const readings = hyperliquidReadings(json("hyperliquid.json"), BASES)
    return { parser: "hyperliquidReadings + perpItems (hyperliquid), fresh watcher", readings, ...watched((w) => perpItems(PERP_VENUE, readings, w, ctx)) }
  },
  "kalshi-fed.json": () => ({ parser: "kalshiMarkets (odds:kalshi)", output: kalshiMarkets(json("kalshi-fed.json").markets) }),
  "korea-bithumb-alerts.json": () => jsonSpec("korea:bithumb_alerts", "korea-bithumb-alerts.json"),
  "korea-bithumb-notices.json": () => jsonSpec("korea:bithumb", "korea-bithumb-notices.json"),
  "korea-upbit-markets.json": () => diffSpec("korea:upbit", "korea-upbit-markets.json"),
  "kraken-futures.json": () => ({ parser: "krakenFuturesReadings (kraken_futures)", output: krakenFuturesReadings(json("kraken-futures.json"), BASES) }),
  "kraken-pairs.json": () => diffSpec("kraken_pairs", "kraken-pairs.json"),
  "kraken-status.json": () => statuspageSpec("status_kraken", "kraken-status.json"),
  "mempool-fees.json": () => ({ parser: "btcFeeItems (chain:btc_fees), fresh watcher", ...watched((w) => btcFeeItems(json("mempool-fees.json"), w, ctx)) }),
  "polymarket-crypto.json": () => ({ parser: "polymarketMarkets crypto (odds:polymarket)", output: polymarketMarkets(json("polymarket-crypto.json"), "crypto", NOW) }),
  "polymarket-fed.json": () => ({ parser: "polymarketMarkets fed (odds:polymarket)", output: polymarketMarkets(json("polymarket-fed.json"), "fed", NOW) }),
  "rss-beincrypto.xml": () => rssSpec("rss:beincrypto", "rss-beincrypto.xml"),
  "rss-bitcoinmagazine.xml": () => rssSpec("rss:bitcoinmagazine", "rss-bitcoinmagazine.xml"),
  "rss-dlnews.xml": () => rssSpec("rss:dlnews", "rss-dlnews.xml"),
  "slowmist.html": () => {
    const s = spec("hacks:slowmist")
    if (!s.mapHtml) throw new Error("hacks:slowmist has no mapHtml")
    return { parser: "hacks:slowmist.mapHtml", output: s.mapHtml(text("slowmist.html"), ctx) }
  },
  "solana-status.json": () => statuspageSpec("status_solana", "solana-status.json"),
  "stocktwits-btc.json": () => {
    const body = json("stocktwits-btc.json")
    return { parser: "messageRate + stocktwitsRateItems BTC (stocktwits), fresh watcher", message_rate: messageRate(body.messages), ...watched((w) => stocktwitsRateItems("BTC", body, w, ctx)) }
  },
  "stocktwits-trending.json": () => ({ parser: "stocktwitsTrendingItems (stocktwits), fresh watcher", ...watched((w) => stocktwitsTrendingItems(json("stocktwits-trending.json"), w, ctx)) }),
  "telegram-binance.html": () => telegramSpec("binance_announcements", "telegram-binance.html"),
  "telegram.html": () => telegramSpec("telegram:whale_alert_io", "telegram.html"),
  "wikipedia.json": () => ({ parser: "pageviewRatio (wikipedia)", output: pageviewRatio(json("wikipedia.json")) }),
}

/** Coinalyze symbol → base, from the saved markets list (as coinalyzePoll builds it). */
const coinalyzeBySymbol = () => new Map([...coinalyzeSymbols(json("coinalyze-markets.json"), BASES.keys())].flatMap(([base, symbols]) => symbols.map((s) => [s, base] as const)))

describe("contracts: parsed source fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const fixtures = readdirSync(DIR).sort()

  it("every fixture has a parser here", () => {
    const missing = fixtures.filter((f) => !(f in PARSERS))
    const stale = Object.keys(PARSERS).filter((f) => !fixtures.includes(f))
    if (missing.length || stale.length) throw new Error(`fixtures without a contract parser: ${missing.join(", ") || "none"}; parsers without a fixture: ${stale.join(", ") || "none"}`)
  })

  for (const name of Object.keys(PARSERS).sort()) {
    it(name, () => {
      const { parser, ...rest } = PARSERS[name]()
      matchJson(`parsed/${name}.json`, { fixture: name, parser, ...rest })
    })
  }

  it("no stale snapshots", () => checkNoOrphans("parsed", Object.keys(PARSERS).map((f) => `${f}.json`)))
})
