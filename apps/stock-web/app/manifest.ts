import type { MetadataRoute } from "next"
import { manifest } from "@mb/web-kit/metadata"
import { site } from "@/lib/site"

export default function Manifest(): MetadataRoute.Manifest {
  return manifest(site, { svgIcon: true })
}
