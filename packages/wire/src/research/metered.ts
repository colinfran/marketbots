import { errorMessage, type Logger } from "@mb/engine-kit/log"
import type { SearchMeter } from "@mb/engine-kit/state/search-usage"
import type { SearchRange, SearchResult } from "./search"

/**
 * Pacing for research's metered search providers (docs/SERVER.md §9): each day of a UTC month adds
 * an equal share of a provider's monthly budget, and a share left unused carries over to later
 * days. Both bots use the same accounts, so each engine keeps to 1 / SHARING_ENGINES of that by
 * its own spend, which `search_usage` (the SearchMeter) keeps across restarts.
 */

export const SHARING_ENGINES = 2

/** A metered provider research asks when the free engines find too little. */
export type MeteredSearch = {
  name: string
  /** Up to `maxResults` results within `range` (since `since`, a date), or null when this engine's allowance has none left. Throws on failure. */
  search: (query: string, opts: { range: SearchRange; since: string; maxResults: number; timeoutMs: number }) => Promise<SearchResult[] | null>
}

export const monthOf = (now: Date) => now.toISOString().slice(0, 7)

/** What a monthly budget's days so far allow (UTC): an equal share a day, in whole searches when `whole`. */
export const allowanceSoFar = (monthly: number, now: Date, whole = true) => {
  const perDay = monthly / new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  return (whole ? Math.floor(perDay) : perDay) * now.getUTCDate()
}

export type SpendLedger = ReturnType<typeof spendLedger>

/** This engine's spend per provider this month: read from the meter at the month's first use, then kept here and written through. */
export const spendLedger = (meter: SearchMeter | undefined, log: Logger) => {
  let month = ""
  let spent: Record<string, number> = {}
  let loading: Promise<void> | null = null
  const ready = async (now: Date) => {
    const m = monthOf(now)
    if (m === month) return
    loading ??= (async () => {
      spent = meter ? await meter.load(m) : {}
      month = m
    })().finally(() => {
      loading = null
    })
    await loading
  }
  const save = (provider: string, amount: number) =>
    void meter?.add(month, provider, amount).catch((error: unknown) => log.warn("local research: a search's cost wasn't saved", { provider, error: errorMessage(error) }))

  return {
    /** Spends `amount` of a provider if this engine's share of `allowance` (the month's so far) still has it. */
    take: async (provider: string, amount: number, allowance: number, now: Date) => {
      await ready(now)
      if ((spent[provider] ?? 0) + amount > allowance / SHARING_ENGINES) return false
      spent[provider] = (spent[provider] ?? 0) + amount
      save(provider, amount)
      return true
    },
    /** Corrects a spend by `delta` (an estimate's error). */
    adjust: (provider: string, delta: number) => {
      if (!delta) return
      spent[provider] = (spent[provider] ?? 0) + delta
      save(provider, delta)
    },
    /** This engine's spend on a provider this month, as far as it knows. */
    spent: (provider: string) => spent[provider] ?? 0,
  }
}
