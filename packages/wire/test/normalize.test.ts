import { describe, expect, it } from "vitest"
import { canonicalUrl, itemId, normalizeRaw, stripHtml } from "../src/normalize"

const NOW = new Date("2026-10-27T12:00:00Z")

describe("normalize", () => {
  it("strips HTML and tracking, decodes entities, and keeps ids stable", () => {
    expect(stripHtml("<p>Bitcoin&nbsp;tops &#36;80K &amp; more</p><script>alert(1)</script>").replace(/\s+/g, " ").trim()).toBe("Bitcoin tops $80K & more")
    expect(canonicalUrl("https://www.coindesk.com/markets/2026/10/27/btc/?utm_source=x&id=7#top")).toBe("https://www.coindesk.com/markets/2026/10/27/btc?id=7")
    expect(canonicalUrl("javascript:alert(1)")).toBeNull()
    const a = normalizeRaw("rss:x", { title: "Hello", url: "https://a.com/x?utm_medium=y" }, NOW)!
    const b = normalizeRaw("rss:x", { title: "Hello again", url: "https://a.com/x" }, NOW)!
    expect(a.id).toBe(b.id)
    expect(itemId("rss:x", { sourceId: "g1", title: "t" }, null)).not.toBe(itemId("rss:y", { sourceId: "g1", title: "t" }, null))
  })

  it("never lets a source claim the future, and drops empty titles", () => {
    expect(normalizeRaw("s", { title: "x", publishedAt: new Date("2030-01-01") }, NOW)!.published_at).toEqual(NOW)
    expect(normalizeRaw("s", { title: "  <b></b> " }, NOW)).toBeNull()
  })
})
