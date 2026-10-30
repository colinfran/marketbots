import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { sitemap } from "@mb/web-kit/metadata"
import type { MetadataRoute } from "next"
import { collections } from "@/lib/db"
import { symbolSlug } from "@/lib/format"
import { site } from "@/lib/site"

const pairs = (symbols: readonly string[]) => symbols.map((s) => ({ url: `${site.url}/markets/${symbolSlug(s)}`, changeFrequency: "hourly" as const, priority: 0.6 }))

/** Static pages plus every watched pair, journal day and decision, generated at request time. */
export default async function Sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemap({
    site,
    pages: [
      { path: "/", fresh: true, changeFrequency: "hourly", priority: 1 },
      { path: "/news", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/holdings", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/markets", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/agent", fresh: true, changeFrequency: "hourly", priority: 0.7 },
      { path: "/journal", fresh: true, changeFrequency: "daily", priority: 0.8 },
      { path: "/trades", fresh: true, changeFrequency: "hourly", priority: 0.7 },
      { path: "/analytics", fresh: true, changeFrequency: "daily", priority: 0.7 },
      { path: "/about", changeFrequency: "monthly", priority: 0.6 },
    ],
    entries: async () => {
      const db = await collections()
      const [settings, days, decisions] = await Promise.all([
        db.settings.findOne({ _id: "current" }, { projection: { "settings.universe": 1 } }),
        db.dailyStats.find({}, { projection: { day: 1, updated_at: 1 } }).sort({ day: -1 }).limit(2_000).toArray(),
        db.decisions.find({}, { projection: { _id: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20_000).toArray(),
      ])
      return [
        ...pairs(settings?.settings.universe.kraken_symbols ?? DEFAULT_SETTINGS.universe.kraken_symbols),
        ...days.map((d) => ({ url: `${site.url}/journal/${d.day}`, lastModified: d.updated_at, changeFrequency: "weekly" as const, priority: 0.6 })),
        // A decision page tracks how its thesis is doing, so it changes while the position is open.
        ...decisions.map((d) => ({ url: `${site.url}/decisions/${d._id}`, lastModified: d.created_at, changeFrequency: "daily" as const, priority: 0.5 })),
      ]
    },
    fallback: () => pairs(DEFAULT_SETTINGS.universe.kraken_symbols),
  })
}
