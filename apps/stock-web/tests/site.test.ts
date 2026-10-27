import { describe, expect, it } from "vitest"
import { jsonLd, pageMetadata, site } from "@/lib/site"

describe("jsonLd", () => {
  it("serializes data for an inline script tag", () => {
    expect(JSON.parse(jsonLd({ a: 1 }).__html)).toEqual({ a: 1 })
  })

  it("escapes < so data can't close the script tag", () => {
    const { __html } = jsonLd({ headline: "</script><script>alert(1)</script>" })
    expect(__html).not.toContain("<")
    expect(__html).toContain("\\u003c/script>")
    expect(JSON.parse(__html).headline).toBe("</script><script>alert(1)</script>")
  })
})

describe("pageMetadata", () => {
  it("builds a complete website metadata block", () => {
    const meta = pageMetadata({ title: "Trades", description: "Every fill.", path: "/trades" })
    expect(meta).toEqual({
      title: "Trades",
      description: "Every fill.",
      alternates: { canonical: "/trades" },
      openGraph: {
        type: "website",
        url: "/trades",
        siteName: site.name,
        title: `Trades · ${site.name}`,
        description: "Every fill.",
        locale: "en_US",
        images: [site.ogImage],
      },
      twitter: { card: "summary_large_image", title: `Trades · ${site.name}`, description: "Every fill.", images: [site.ogImage] },
    })
  })

  it("doesn't repeat the site name in share titles", () => {
    const meta = pageMetadata({ title: site.title, description: "d", path: "/" })
    expect(meta.openGraph.title).toBe(site.title)
    expect(meta.twitter.title).toBe(site.title)
  })

  it("adds article fields for articles only", () => {
    const article = pageMetadata({ title: "Report", description: "d", path: "/reports/1", type: "article", publishedTime: "2026-10-26T14:00:00Z" })
    expect(article.openGraph).toMatchObject({ type: "article", publishedTime: "2026-10-26T14:00:00Z", authors: [site.author.url] })

    const page = pageMetadata({ title: "Report", description: "d", path: "/reports", publishedTime: "2026-10-26T14:00:00Z" })
    expect(page.openGraph).not.toHaveProperty("publishedTime")
    expect(page.openGraph).not.toHaveProperty("authors")
  })
})

describe("site", () => {
  it("has an absolute https URL with no trailing slash", () => {
    expect(site.url).toMatch(/^https:\/\/[^/]+$/)
  })
})
