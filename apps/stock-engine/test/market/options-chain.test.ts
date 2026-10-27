import type { ChainContract } from "@mb/stock-core/context"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { describe, expect, it } from "vitest"
import { buildMenu, structureQuote, toChainContract } from "../../src/market/options-chain"

const c = (strike: number, type: "call" | "put", overrides: Partial<ChainContract> = {}): ChainContract => ({
  symbol: `X${type}${strike}`,
  type,
  expiration: "2026-11-20",
  dte: 25,
  strike,
  bid: 1,
  ask: 1.05,
  mid: 1.025,
  spread_pct: 4.9,
  delta: type === "call" ? Math.max(0.05, 1 - strike / 200) : -Math.max(0.05, strike / 200 - 0.2),
  iv: 0.4,
  open_interest: 1_000,
  ...overrides,
})

describe("buildMenu", () => {
  const s = { ...DEFAULT_SETTINGS.options, contracts_per_underlying: 6 }

  it("keeps liquid contracts in the window, spread across strikes, calls and puts", () => {
    const calls = [100, 110, 120, 130, 140, 150].map((k) => c(k, "call"))
    const puts = [100, 110, 120, 130].map((k) => c(k, "put"))
    const menu = buildMenu([...calls, ...puts], s)
    expect(menu.filter((x) => x.type === "call").map((x) => x.strike)).toEqual([100, 130, 150])
    expect(menu.filter((x) => x.type === "put")).toHaveLength(3)
  })

  it("drops wide, thin, unpriced-greek and out-of-window contracts", () => {
    const menu = buildMenu([c(100, "call", { spread_pct: 30 }), c(110, "call", { open_interest: 10 }), c(120, "call", { delta: null }), c(130, "call", { dte: 5 }), c(140, "call", { delta: 0.02 }), c(150, "call")], s)
    expect(menu.map((x) => x.strike)).toEqual([150])
  })

  it("prefers the expirations nearest the middle of the window", () => {
    const menu = buildMenu([c(100, "call", { expiration: "2026-11-06", dte: 11 }), c(100, "call", { expiration: "2026-11-13", dte: 18, symbol: "a" }), c(100, "call", { expiration: "2026-11-27", dte: 32, symbol: "b" }), c(100, "call", { expiration: "2026-12-04", dte: 39, symbol: "c" })], s)
    expect(menu.map((x) => x.expiration)).toEqual(["2026-11-27", "2026-12-04"])
  })
})

describe("toChainContract", () => {
  it("joins a listed contract with its quote and greeks", () => {
    const row = toChainContract(
      { id: "1", symbol: "NVDA261120C00140000", name: "n", status: "active", tradable: true, expiration_date: "2026-11-20", underlying_symbol: "NVDA", type: "call", style: "american", strike_price: "140", open_interest: "2500" },
      { latestQuote: { bp: 5.9, ap: 6.1, t: "" }, greeks: { delta: 0.5234, gamma: 0, theta: 0, vega: 0, rho: 0 }, impliedVolatility: 0.4512 },
      "2026-10-26",
    )
    expect(row).toEqual({ symbol: "NVDA261120C00140000", type: "call", expiration: "2026-11-20", dte: 25, strike: 140, bid: 5.9, ask: 6.1, mid: 6, spread_pct: 3.3, delta: 0.523, iv: 0.451, open_interest: 2500 })
    const listed = { id: "2", symbol: "x", name: "x", status: "active" as const, tradable: true, expiration_date: "2026-11-20", underlying_symbol: "X", type: "call" as const, style: "american" as const, strike_price: "1" }
    // No bid: not tradable at a fair price.
    expect(toChainContract(listed, { latestQuote: { bp: 0, ap: 0.05, t: "" } }, "2026-10-26")).toBeNull()
  })
})

describe("structureQuote", () => {
  it("nets long and short legs", () => {
    const q = structureQuote(
      [
        { symbol: "L", side: "long" },
        { symbol: "S", side: "short" },
      ],
      { L: { latestQuote: { bp: 5.9, ap: 6.1, t: "" }, greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0, rho: 0 } }, S: { latestQuote: { bp: 2.4, ap: 2.6, t: "" }, greeks: { delta: 0.3, gamma: 0, theta: 0, vega: 0, rho: 0 } } },
    )
    expect(q).toEqual({ mid: 3.5, exitValue: 3.3, entryValue: 3.7, delta: 0.2 })
    expect(structureQuote([{ symbol: "L", side: "long" }], {})).toBeNull()
  })
})
