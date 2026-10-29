import type { SearchUsageDoc } from "@mb/core/db"
import type { Collection } from "mongodb"

/**
 * This bot's spend on research's metered search providers, by UTC month (`search_usage`,
 * docs/SERVER.md §9), so research can pace them across restarts.
 */
export type SearchMeter = {
  /** The month's ("YYYY-MM") spend per provider, each in its own unit. */
  load(month: string): Promise<Record<string, number>>
  /** Adds to a provider's spend for the month. */
  add(month: string, provider: string, amount: number): Promise<void>
}

export const mongoSearchMeter = (col: Collection<SearchUsageDoc>): SearchMeter => ({
  load: async (month) => (await col.findOne({ _id: month }))?.spent ?? {},
  add: async (month, provider, amount) => {
    await col.updateOne({ _id: month }, { $inc: { [`spent.${provider}`]: amount }, $set: { updated_at: new Date() } }, { upsert: true })
  },
})
