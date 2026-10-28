import type { MetadataRoute } from "next"
import { robots } from "@mb/web-kit/metadata"
import { site } from "@/lib/site"

export default function Robots(): MetadataRoute.Robots {
  return robots(site)
}
