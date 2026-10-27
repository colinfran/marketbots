import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { describe, it } from "vitest"
import type { MarketHub } from "../../src/market/hub"
import { silentLogger } from "../../src/log"
import { CATALOG } from "../../src/wire/catalog"
import { CoinbasePremium } from "../../src/wire/sources/coinbase-ws"
import { KrakenMarketSignals } from "../../src/wire/sources/kraken-market"
import type { SourceSpec } from "../../src/wire/types"
import { matchJson } from "./snapshot"

/**
 * The news engine's source catalog: every entry as main.ts hands it to the Wire (CATALOG plus the
 * two market-data sources built from engine objects). Functions are not data, so they are listed
 * by name, except `urlFor` (called for two sample symbols) and `headers` (called with an env whose
 * every variable reads "<NAME>").
 */

/** Fields in a fixed order, so a refactor that only reorders object literals is not a diff. */
const FIELDS = ["id", "kind", "url", "symbols", "interval_s", "tier", "wire_kind", "category_hint", "key_env", "default_enabled", "channel", "selectors", "render", "note"] as const

const SAMPLE_SYMBOLS = ["BTC/USD", "SOL/USD"]

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
  it("every source entry", () => {
    const marketSignals = new KrakenMarketSignals({} as MarketHub, () => DEFAULT_SETTINGS, silentLogger, () => undefined)
    const coinbasePremium = new CoinbasePremium(() => null, () => DEFAULT_SETTINGS, silentLogger)
    const catalog = [...CATALOG, marketSignals.spec(), coinbasePremium.spec()]
    matchJson("wire-catalog.json", { count: catalog.length, sources: catalog.map(describeSpec) })
  })
})
