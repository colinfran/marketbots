import type { MetadataRoute } from "next"
import { site } from "@/lib/site"

/** One page; the bots' own pages are in their dashboards' sitemaps. */
export default function Sitemap(): MetadataRoute.Sitemap {
  return [{ url: site.url, changeFrequency: "monthly", priority: 1 }]
}
