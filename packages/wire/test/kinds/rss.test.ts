import { describe, expect, it, vi } from "vitest"
import { parseFeed } from "../../src/kinds/rss"

const feed = (pubDate: string) => `<?xml version="1.0"?><rss version="2.0"><channel><item><title>ACME beats</title><link>https://feed.test/1</link><pubDate>${pubDate}</pubDate></item></channel></rss>`
const published = (pubDate: string) => parseFeed(feed(pubDate))[0].publishedAt?.toISOString()

describe("RSS feeds", () => {
  it("reads a date-time without a zone (Investing.com's) as UTC, whatever the host's zone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles")
    expect(published("2026-10-27 02:16:56")).toBe("2026-10-27T02:16:56.000Z")
    expect(published("2026-10-27T02:16")).toBe("2026-10-27T02:16:00.000Z")
    // A zone, when there is one, still counts.
    expect(published("Tue, 27 Oct 2026 01:40 GMT")).toBe("2026-10-27T01:40:00.000Z")
    expect(published("2026-10-27T02:16:56-04:00")).toBe("2026-10-27T06:16:56.000Z")
  })
})
