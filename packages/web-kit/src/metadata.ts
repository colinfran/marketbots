import type { MetadataRoute } from "next"
import { connection } from "next/server"

/**
 * SEO metadata for a dashboard: per-page metadata, JSON-LD, robots, the sitemap and the web app
 * manifest. Each app describes itself once (its `site`) and binds these to it.
 */

export type ShareImage = { url: string; width: number; height: number; alt: string }

/** Site identity used for SEO metadata, structured data, the sitemap and share images. */
export type Site = {
  name: string
  /** Canonical origin, no trailing slash. */
  url: string
  title: string
  tagline: string
  description: string
  keywords: readonly string[]
  author: { name: string; url: string }
  /** The default share image. */
  ogImage: ShareImage
}

/** Serializes JSON-LD safely for an inline <script> tag. */
export const jsonLd = (data: unknown) => ({ __html: JSON.stringify(data).replace(/</g, "\\u003c") })

/** Trims text to a meta-tag length on a word boundary. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * Full per-page metadata. Next merges `openGraph`/`twitter` shallowly, and a page's own
 * `openGraph.images` beats a file-based image, so each page sets the whole block (plus its own
 * canonical URL and image) rather than relying on the root layout.
 */
export const pageMetadataFor =
  (site: Site) =>
  ({
    title,
    description,
    path,
    type = "website",
    publishedTime,
    image = site.ogImage,
  }: {
    title: string
    description: string
    path: string
    type?: "website" | "article"
    publishedTime?: string
    image?: ShareImage
  }) => {
    const shareTitle = title.includes(site.name) ? title : `${title} · ${site.name}`
    return {
      title,
      description,
      alternates: { canonical: path },
      openGraph: {
        type,
        url: path,
        siteName: site.name,
        title: shareTitle,
        description,
        locale: "en_US",
        images: [image],
        ...(type === "article" ? { publishedTime, authors: [site.author.url] } : {}),
      },
      twitter: { card: "summary_large_image" as const, title: shareTitle, description, images: [image] },
    }
  }

/** robots.txt: everything but the API. /login and /admin stay crawlable so bots can read their noindex tag. */
export const robots = (site: Pick<Site, "url">): MetadataRoute.Robots => ({
  rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
  sitemap: `${site.url}/sitemap.xml`,
  host: site.url,
})

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>

/** A static page of the sitemap; `fresh` stamps it with the time of the request. */
export type SitemapPage = { path: string; changeFrequency: ChangeFrequency; priority: number; fresh?: boolean }

/**
 * sitemap.xml at request time: the static pages, then the bot's records (`entries`). If the
 * database is unreachable it serves the static pages and `fallback` only.
 */
export const sitemap = async ({
  site,
  pages,
  entries,
  fallback = () => [],
}: {
  site: Pick<Site, "url">
  pages: SitemapPage[]
  entries: () => Promise<MetadataRoute.Sitemap>
  fallback?: () => MetadataRoute.Sitemap
}): Promise<MetadataRoute.Sitemap> => {
  await connection()
  const now = new Date()
  const statics: MetadataRoute.Sitemap = pages.map((p) => ({
    url: p.path === "/" ? site.url : `${site.url}${p.path}`,
    ...(p.fresh ? { lastModified: now } : {}),
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }))
  try {
    return [...statics, ...(await entries())]
  } catch (error) {
    console.error("[sitemap] database unavailable, serving static pages only:", error)
    return [...statics, ...fallback()]
  }
}

/** The web app manifest. `svgIcon` lists app/icon.svg (only for an app that has one). */
export const manifest = (site: Pick<Site, "name" | "tagline">, { svgIcon = false }: { svgIcon?: boolean } = {}): MetadataRoute.Manifest => ({
  name: site.name,
  short_name: site.name,
  description: site.tagline,
  start_url: "/",
  display: "standalone",
  background_color: "#0a0a0a",
  theme_color: "#0a0a0a",
  categories: ["finance", "business"],
  icons: [
    ...(svgIcon ? [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] : []),
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
})
