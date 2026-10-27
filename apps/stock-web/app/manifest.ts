import type { MetadataRoute } from "next"
import { manifest } from "@mb/web-kit/metadata"
import { site } from "@/lib/site"

/** Stock has no app/icon.svg, so the manifest lists only the PNG icons. */
export default function Manifest(): MetadataRoute.Manifest {
  return manifest(site)
}
