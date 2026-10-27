import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import type { Alpaca } from "../../src/alpaca/client"
import { silentLogger } from "../../src/log"
import { PriceCoverage } from "../../src/market/price-layers"
import { CATALOG } from "../../src/wire/catalog"
import { alpacaNewsSpec, moversSpec } from "../../src/wire/sources/alpaca"
import { StockMarketSignals } from "../../src/wire/sources/stock-market"
import type { SourceSpec } from "../../src/wire/types"
import { matchJson } from "./snapshot"

/**
 * The news engine's source catalog: every entry as main.ts hands it to the Wire (CATALOG, the two
 * Alpaca sources, the market-anomaly source and the price-coverage layers, built from harmless
 * fakes). Functions are not data, so they are listed by name, except `urlFor` (called for two
 * sample symbols) and `headers` (called with an env whose every variable reads "<NAME>").
 */

/** Fields in a fixed order, so a refactor that only reorders object literals is not a diff. */
const FIELDS = ["id", "kind", "url", "symbols", "interval_s", "tier", "wire_kind", "category_hint", "key_env", "default_enabled", "channel", "selectors", "render", "note"] as const

const SAMPLE_SYMBOLS = ["AAPL", "NVDA"]

const placeholderEnv = new Proxy({} as Record<string, string>, { get: (_, key) => (typeof key === "string" ? `<${key}>` : undefined) })

export const describeSpec = (spec: SourceSpec) => {
  const out: Record<string, unknown> = {}
  const record = spec as unknown as Record<string, unknown>
  for (const field of FIELDS) if (record[field] !== undefined) out[field] = record[field]
  if (spec.urlFor) out.url_for = Object.fromEntries(SAMPLE_SYMBOLS.map((s) => [s, spec.urlFor!(s)]))
  if (spec.headers) out.headers = spec.headers(placeholderEnv)
  const known = new Set<string>([...FIELDS, "urlFor", "headers"])
  for (const [key, value] of Object.entries(record)) if (!known.has(key) && typeof value !== "function" && value !== undefined) out[key] = value
  const functions = Object.entries(record)
    .filter(([key, value]) => typeof value === "function" && key !== "urlFor" && key !== "headers")
    .map(([key]) => key)
  if (functions.length) out.functions = functions
  return out
}

describe("contracts: wire catalog", () => {
  // finnhub_company's urlFor puts yesterday and today in the URL: pin the clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-27T15:00:00Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("every source entry", () => {
    const alpaca = {} as Alpaca
    const settings = () => DEFAULT_SETTINGS
    const marketSignals = new StockMarketSignals(alpaca, settings, silentLogger, () => null, () => undefined)
    const coverage = new PriceCoverage({
      alpaca,
      universe: { symbols: [], refresh: async () => false, lastError: null } as unknown as ConstructorParameters<typeof PriceCoverage>[0]["universe"],
      marketStream: { barsRejected: false, barsSubscribed: false } as unknown as ConstructorParameters<typeof PriceCoverage>[0]["marketStream"],
      settings,
      log: silentLogger,
      sessionOpen: () => false,
      onBars: () => undefined,
      onTracked: () => undefined,
    })
    const catalog = [...CATALOG, alpacaNewsSpec(alpaca), moversSpec(alpaca, settings, () => false), marketSignals.spec(), ...coverage.specs()]
    matchJson("wire-catalog.json", { count: catalog.length, sources: catalog.map(describeSpec) })
  })
})
