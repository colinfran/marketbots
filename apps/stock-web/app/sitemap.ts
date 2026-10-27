import { sitemap } from "@mb/web-kit/metadata"
import type { MetadataRoute } from "next"
import { collections } from "@/lib/db"
import { site } from "@/lib/site"

/** Static pages plus every report, journal day and traded symbol, generated at request time. */
export default async function Sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemap({
    site,
    pages: [
      { path: "/", fresh: true, changeFrequency: "hourly", priority: 1 },
      { path: "/live", fresh: true, changeFrequency: "always", priority: 0.9 },
      { path: "/holdings", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/core", fresh: true, changeFrequency: "daily", priority: 0.7 },
      { path: "/markets", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/research", fresh: true, changeFrequency: "hourly", priority: 0.8 },
      { path: "/journal", fresh: true, changeFrequency: "daily", priority: 0.8 },
      { path: "/trades", fresh: true, changeFrequency: "hourly", priority: 0.7 },
      { path: "/analytics", fresh: true, changeFrequency: "daily", priority: 0.7 },
      { path: "/strategies", fresh: true, changeFrequency: "daily", priority: 0.6 },
      { path: "/about", changeFrequency: "monthly", priority: 0.6 },
    ],
    entries: async () => {
      const db = await collections()
      const [reports, days, symbols] = await Promise.all([
        db.reports.find({}, { projection: { _id: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20_000).toArray(),
        db.cycles.distinct("trading_day"),
        db.orders.distinct("symbol", { status: "filled", asset_class: "us_equity" }),
      ])
      return [
        ...days.map((day) => ({ url: `${site.url}/journal/${day}`, changeFrequency: "daily" as const, priority: 0.6 })),
        ...reports.map((r) => ({ url: `${site.url}/research/${r._id}`, lastModified: r.created_at, changeFrequency: "never" as const, priority: 0.5 })),
        ...symbols.map((s) => ({ url: `${site.url}/markets/${s}`, changeFrequency: "daily" as const, priority: 0.5 })),
      ]
    },
  })
}
