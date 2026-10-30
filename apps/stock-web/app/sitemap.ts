import { sitemap } from "@mb/web-kit/metadata"
import type { MetadataRoute } from "next"
import { collections } from "@/lib/db"
import { site } from "@/lib/site"

/** Static pages plus every journal day and traded symbol, generated at request time. */
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
      const [days, symbols] = await Promise.all([
        db.dailyStats.distinct("trading_day"),
        db.orders.distinct("symbol", { status: "filled", asset_class: "us_equity" }),
      ])
      return [
        ...days.map((day) => ({ url: `${site.url}/journal/${day}`, changeFrequency: "daily" as const, priority: 0.6 })),
        ...symbols.map((s) => ({ url: `${site.url}/markets/${s}`, changeFrequency: "daily" as const, priority: 0.5 })),
      ]
    },
  })
}
