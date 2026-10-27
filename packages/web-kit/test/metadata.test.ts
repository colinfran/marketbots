import { describe, expect, it } from "vitest"
import { clip, manifest, pageMetadataFor, robots, type Site } from "../src/metadata"

const site: Site = {
  name: "TestBot",
  url: "https://testbot.example",
  title: "TestBot: a test",
  tagline: "A tagline.",
  description: "A description.",
  keywords: ["test"],
  author: { name: "Author", url: "https://author.example" },
  ogImage: { url: "/og.png", width: 1200, height: 630, alt: "TestBot" },
}

describe("robots", () => {
  it("keeps /login and /admin crawlable so bots can read their noindex tag", () => {
    expect(robots(site)).toEqual({ rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }], sitemap: "https://testbot.example/sitemap.xml", host: "https://testbot.example" })
  })
})

describe("manifest", () => {
  it("lists app/icon.svg only for an app that has one", () => {
    expect(manifest(site, { svgIcon: true }).icons?.map((i) => i.src)).toEqual(["/icon.svg", "/icon-192.png", "/icon-512.png"])
    expect(manifest(site).icons?.map((i) => i.src)).toEqual(["/icon-192.png", "/icon-512.png"])
  })

  it("describes the site", () => {
    expect(manifest(site)).toMatchObject({ name: "TestBot", short_name: "TestBot", description: "A tagline.", start_url: "/", display: "standalone" })
  })
})

describe("pageMetadataFor", () => {
  const pageMetadata = pageMetadataFor(site)

  it("uses the site's share image unless the page has its own", () => {
    expect(pageMetadata({ title: "Trades", description: "d", path: "/trades" }).openGraph.images).toEqual([site.ogImage])
    const image = { url: "/decisions/1/opengraph-image", width: 1200, height: 630, alt: "A decision" }
    const meta = pageMetadata({ title: "Decision", description: "d", path: "/decisions/1", image })
    expect(meta.openGraph.images).toEqual([image])
    expect(meta.twitter.images).toEqual([image])
  })
})

describe("clip", () => {
  it("trims to a meta-tag length with an ellipsis", () => {
    expect(clip("short", 10)).toBe("short")
    expect(clip("a sentence that is too long", 12)).toBe("a sentence…")
  })
})
