import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import type { MetadataRoute } from "next"
import { connection } from "next/server"
import { collections } from "@/lib/db"
import { symbolSlug } from "@/lib/format"
import { site } from "@/lib/site"

/** Static pages plus every watched pair, journal day, AI cycle, decision and backtest, generated at request time. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection()
  const now = new Date()
  const pages: MetadataRoute.Sitemap = [
    { url: site.url, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${site.url}/live`, lastModified: now, changeFrequency: "always", priority: 0.9 },
    { url: `${site.url}/holdings`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${site.url}/markets`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${site.url}/research`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${site.url}/journal`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${site.url}/trades`, lastModified: now, changeFrequency: "hourly", priority: 0.7 },
    { url: `${site.url}/analytics`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: `${site.url}/strategies`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${site.url}/about`, changeFrequency: "monthly", priority: 0.6 },
  ]
  const pairs = (symbols: readonly string[]) =>
    symbols.map((s) => ({ url: `${site.url}/markets/${symbolSlug(s)}`, changeFrequency: "hourly" as const, priority: 0.6 }))
  try {
    const db = await collections()
    // Skipped cycles made no AI call and have nothing to read, so only cycles with decisions are listed.
    const [settings, days, cycles, decisions, backtests] = await Promise.all([
      db.settings.findOne({ _id: "current" }, { projection: { "settings.universe": 1 } }),
      db.dailyStats.find({}, { projection: { day: 1, updated_at: 1 } }).sort({ day: -1 }).limit(2_000).toArray(),
      db.cycles.find({ "decision_ids.0": { $exists: true } }, { projection: { _id: 1, finished_at: 1, started_at: 1 } }).sort({ started_at: -1 }).limit(5_000).toArray(),
      db.decisions.find({}, { projection: { _id: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20_000).toArray(),
      db.backtests.find({ status: "completed" }, { projection: { _id: 1, finished_at: 1 } }).sort({ created_at: -1 }).limit(200).toArray(),
    ])
    return [
      ...pages,
      ...pairs(settings?.settings.universe.kraken_symbols ?? DEFAULT_SETTINGS.universe.kraken_symbols),
      ...days.map((d) => ({ url: `${site.url}/journal/${d.day}`, lastModified: d.updated_at, changeFrequency: "weekly" as const, priority: 0.6 })),
      ...cycles.map((c) => ({ url: `${site.url}/research/${c._id}`, lastModified: c.finished_at ?? c.started_at, changeFrequency: "never" as const, priority: 0.5 })),
      // A decision page tracks how its thesis is doing, so it changes while the position is open.
      ...decisions.map((d) => ({ url: `${site.url}/decisions/${d._id}`, lastModified: d.created_at, changeFrequency: "daily" as const, priority: 0.5 })),
      ...backtests.map((b) => ({ url: `${site.url}/strategies/backtests/${b._id}`, lastModified: b.finished_at ?? undefined, changeFrequency: "never" as const, priority: 0.3 })),
    ]
  } catch (error) {
    console.error("[sitemap] database unavailable, serving static pages only:", error)
    return [...pages, ...pairs(DEFAULT_SETTINGS.universe.kraken_symbols)]
  }
}
