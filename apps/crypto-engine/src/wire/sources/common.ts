import type { SourceContext } from "../types"

/**
 * Small helpers shared by the crypto wave-2 sources: the universe as base assets, and the number
 * formats item titles use (@mb/wire/sources/common, shared with the stock bot).
 */

export { num, settleAll, signed, usd } from "@mb/wire/sources/common"

/** "BTC/USD" → "BTC". */
export const baseOf = (symbol: string) => symbol.split("/")[0].toUpperCase()

/** The universe as base asset → bot symbol ("BTC" → "BTC/USD"). */
export const universeBases = (ctx: Pick<SourceContext, "symbols">) => new Map(ctx.symbols().universe.map((s) => [baseOf(s), s]))
