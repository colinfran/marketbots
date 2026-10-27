import type { MetadataRoute } from "next"
import { connection } from "next/server"
import { collections } from "@/lib/db"
import { site } from "@/lib/site"

/** Static pages plus every report, journal day and traded symbol, generated at request time. */
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
    { url: `${site.url}/strategies`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${site.url}/about`, changeFrequency: "monthly", priority: 0.6 },
  ]
  try {
    const db = await collections()
    const [reports, days, symbols] = await Promise.all([
      db.reports.find({}, { projection: { _id: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20_000).toArray(),
      db.cycles.distinct("trading_day"),
      db.orders.distinct("symbol", { status: "filled", asset_class: "us_equity" }),
    ])
    return [
      ...pages,
      ...days.map((day) => ({ url: `${site.url}/journal/${day}`, changeFrequency: "daily" as const, priority: 0.6 })),
      ...reports.map((r) => ({ url: `${site.url}/research/${r._id}`, lastModified: r.created_at, changeFrequency: "never" as const, priority: 0.5 })),
      ...symbols.map((s) => ({ url: `${site.url}/markets/${s}`, changeFrequency: "daily" as const, priority: 0.5 })),
    ]
  } catch (error) {
    console.error("[sitemap] database unavailable, serving static pages only:", error)
    return pages
  }
}
