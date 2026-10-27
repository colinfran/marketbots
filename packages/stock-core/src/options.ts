/**
 * Option contract helpers shared by the engine and the dashboard.
 *
 * Alpaca names contracts with OCC-style symbols: root + expiration (YYMMDD) + C/P + strike × 1000
 * padded to 8 digits, e.g. NVDA261120C00140000 = NVDA, 2026-11-20, call, $140.
 */

export const OPTION_MULTIPLIER = 100

export const OCC_PATTERN = /^([A-Z][A-Z0-9.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

export type OptionRight = "call" | "put"

export type ParsedContract = { root: string; expiration: string; type: OptionRight; strike: number }

export const isOptionSymbol = (symbol: string) => OCC_PATTERN.test(symbol)

export const parseOcc = (symbol: string): ParsedContract | null => {
  const m = OCC_PATTERN.exec(symbol.trim().toUpperCase())
  if (!m) return null
  const [, root, yy, mm, dd, cp, strike] = m
  return { root, expiration: `20${yy}-${mm}-${dd}`, type: cp === "C" ? "call" : "put", strike: Number(strike) / 1000 }
}

export const occSymbol = ({ root, expiration, type, strike }: ParsedContract) =>
  `${root}${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" })

/** "NVDA Nov 20 '26 140C" for display. Falls back to the raw symbol. */
export const describeContract = (symbol: string) => {
  const c = parseOcc(symbol)
  if (!c) return symbol
  const [md, yy] = monthDay.format(new Date(`${c.expiration}T12:00:00Z`)).split(", ")
  return `${c.root} ${md} '${yy} ${Number.isInteger(c.strike) ? c.strike : c.strike.toFixed(2)}${c.type === "call" ? "C" : "P"}`
}

/** Calendar days from `today` (YYYY-MM-DD, New York) to an expiration date. */
export const daysToExpiry = (expiration: string, today: string) =>
  Math.round((Date.parse(`${expiration}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)

export const OPTION_STRATEGIES = ["long_call", "long_put", "call_debit_spread", "put_debit_spread"] as const
export type OptionStrategy = (typeof OPTION_STRATEGIES)[number]

export const STRATEGY_LABEL: Record<OptionStrategy, string> = {
  long_call: "Long call",
  long_put: "Long put",
  call_debit_spread: "Call debit spread",
  put_debit_spread: "Put debit spread",
}

/** Calls and call spreads profit when the underlying rises; puts and put spreads when it falls. */
export const isBullish = (strategy: OptionStrategy) => strategy === "long_call" || strategy === "call_debit_spread"

export const isSpread = (strategy: OptionStrategy) => strategy === "call_debit_spread" || strategy === "put_debit_spread"

/** The contract type every leg of a strategy uses. */
export const strategyRight = (strategy: OptionStrategy): OptionRight => (isBullish(strategy) ? "call" : "put")
