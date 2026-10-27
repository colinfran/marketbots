import type { MetadataRoute } from "next"
import { robots } from "@mb/web-kit/metadata"
import { site } from "@/lib/site"

/** /login and /admin stay crawlable so bots can read their noindex tag. */
export default function Robots(): MetadataRoute.Robots {
  return robots(site)
}
