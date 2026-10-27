import { describe, expect, it } from "vitest"
import { blueskyItem } from "../../src/sources/bluesky"

const DID = "did:plc:i3fhjvvkbmirhyu4aeihhrnv"
const handles = new Map([[DID, "wsj.com"]])
const keywords = /\b(bitcoin|ethereum|crypto)\b/i
const post = (text: string, extra: { reply?: unknown; createdAt?: string; operation?: string } = {}) => ({
  did: DID,
  time_us: Date.UTC(2026, 9, 27, 2, 20) * 1000,
  kind: "commit",
  commit: { operation: extra.operation ?? "create", collection: "app.bsky.feed.post", rkey: "3myt5zryg4m2e", record: { text, createdAt: extra.createdAt ?? "2026-10-27T02:19:52.968Z", ...(extra.reply ? { reply: extra.reply } : {}) } },
})

describe("Bluesky (Jetstream)", () => {
  it("turns a matching top-level post into a tier-3 item linked to the post", () => {
    expect(blueskyItem(post("Bitcoin  ETFs saw record inflows today"), handles, keywords)).toEqual({
      sourceId: `${DID}/3myt5zryg4m2e`,
      title: "Bitcoin ETFs saw record inflows today",
      url: "https://bsky.app/profile/wsj.com/post/3myt5zryg4m2e",
      publishedAt: new Date("2026-10-27T02:19:52.968Z"),
      tier: 3,
      kind: "news",
      meta: { author: "wsj.com" },
    })
  })

  it("skips replies, deletes, posts off the keyword list, and caps a future date at the relay time", () => {
    expect(blueskyItem(post("Bitcoin is up", { reply: { root: {} } }), handles, keywords)).toBeNull()
    expect(blueskyItem(post("Bitcoin is up", { operation: "delete" }), handles, keywords)).toBeNull()
    expect(blueskyItem(post("Jay-Z will headline the Super Bowl"), handles, keywords)).toBeNull()
    expect(blueskyItem(post("crypto bill passes", { createdAt: "2030-01-01T00:00:00Z" }), handles, keywords)?.publishedAt).toEqual(new Date(Date.UTC(2026, 9, 27, 2, 20)))
  })
})
