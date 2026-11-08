import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clientKey, LIMITS, type Limits, RateLimiter, rateLimitProxy } from "../src/rate-limit"

const MINUTE = 60_000

const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const limiter = (limits: Partial<Limits> = {}) => {
  const c = clock()
  return { ...c, rl: new RateLimiter({ ...LIMITS, ...limits }, c.now) }
}

/** Spends the whole burst, so the next request is refused. */
const drain = (rl: RateLimiter, key: string) => {
  for (let i = 0; i < LIMITS.burst; i++) expect(rl.take(key)).toEqual({ allowed: true })
}

describe("RateLimiter", () => {
  it("lets a burst through, then refuses with the wait until a point is back", () => {
    const { rl } = limiter()
    drain(rl, "1.2.3.4")
    expect(rl.take("1.2.3.4")).toEqual({ allowed: false, banned: false, retryAfter: 1 })
    // Another visitor has its own bucket.
    expect(rl.take("5.6.7.8")).toEqual({ allowed: true })
  })

  it("refills at perSecond", () => {
    const { rl, advance } = limiter()
    drain(rl, "a")
    advance(1_000)
    for (let i = 0; i < LIMITS.perSecond; i++) expect(rl.take("a").allowed).toBe(true)
    expect(rl.take("a").allowed).toBe(false)
    advance(60_000)
    drain(rl, "a")
  })

  it("charges a prefetch a fifth of a request", () => {
    const { rl } = limiter()
    drain(rl, "a")
    expect(rl.take("a", true).allowed).toBe(false)
    const { rl: fresh } = limiter()
    for (let i = 0; i < LIMITS.burst / LIMITS.prefetchCost - 1; i++) expect(fresh.take("b", true).allowed).toBe(true)
    expect(fresh.take("b").allowed).toBe(false)
  })

  it("bans a visitor who keeps going after refusals, for an hour", () => {
    const { rl, advance } = limiter()
    drain(rl, "a")
    for (let i = 0; i < LIMITS.banAfter - 1; i++) expect(rl.take("a")).toMatchObject({ allowed: false, banned: false })
    expect(rl.take("a")).toEqual({ allowed: false, banned: true, retryAfter: 3_600, newBan: { minutes: 60, count: 1 } })
    advance(30 * MINUTE)
    expect(rl.take("a")).toEqual({ allowed: false, banned: true, retryAfter: 1_800 })
    advance(30 * MINUTE)
    expect(rl.take("a")).toEqual({ allowed: true })
  })

  it("forgives refusals spread wider than the strike window", () => {
    const { rl, advance } = limiter()
    for (let round = 0; round < 3; round++) {
      drain(rl, "a")
      for (let i = 0; i < LIMITS.banAfter - 1; i++) expect(rl.take("a").allowed).toBe(false)
      advance(LIMITS.strikeWindowMs + 1)
    }
    expect(rl.take("a")).toEqual({ allowed: true })
  })

  it("doubles each ban within a day of the last, up to a day, and forgets after a quiet day", () => {
    const { rl, advance } = limiter()
    const ban = () => {
      drain(rl, "a")
      for (let i = 0; i < LIMITS.banAfter - 1; i++) rl.take("a")
      return rl.take("a")
    }
    const minutes = [60, 120, 240, 480, 960, 1440, 1440]
    for (const m of minutes) {
      expect(ban()).toMatchObject({ banned: true, newBan: { minutes: m } })
      advance(m * MINUTE)
    }
    advance(LIMITS.banMemoryMs + 1)
    expect(ban()).toMatchObject({ newBan: { minutes: 60, count: 1 } })
  })

  it("lets the owner's address through and lifts its ban", () => {
    const { rl, advance } = limiter()
    drain(rl, "a")
    for (let i = 0; i < LIMITS.banAfter; i++) rl.take("a")
    expect(rl.take("a")).toMatchObject({ banned: true })
    rl.markOwner("a")
    for (let i = 0; i < 1_000; i++) expect(rl.take("a").allowed).toBe(true)
    advance(LIMITS.ownerMs)
    // The exemption ends with a full bucket and no ban history.
    drain(rl, "a")
    expect(rl.take("a")).toMatchObject({ allowed: false, banned: false })
  })

  it("looks the owner up at most once a minute per address", () => {
    const { rl, advance } = limiter()
    expect(rl.shouldCheckOwner("a")).toBe(true)
    expect(rl.shouldCheckOwner("a")).toBe(false)
    expect(rl.shouldCheckOwner("b")).toBe(true)
    advance(LIMITS.ownerCheckMs)
    expect(rl.shouldCheckOwner("a")).toBe(true)
  })

  it("forgets idle visitors but remembers bans", () => {
    const { rl, advance } = limiter()
    rl.take("idle")
    drain(rl, "banned")
    for (let i = 0; i < LIMITS.banAfter; i++) rl.take("banned")
    expect(rl.size).toBe(2)
    advance(LIMITS.strikeWindowMs + 1)
    rl.take("trigger")
    expect(rl.size).toBe(2) // "idle" swept; "banned" and "trigger" kept
    expect(rl.take("banned")).toMatchObject({ banned: true })
  })

  it("caps the visitors it remembers, keeping banned ones", () => {
    const { rl } = limiter({ maxEntries: 3 })
    drain(rl, "banned")
    for (let i = 0; i < LIMITS.banAfter; i++) rl.take("banned")
    rl.take("b")
    rl.take("c")
    rl.take("d")
    expect(rl.size).toBe(3)
    expect(rl.take("banned")).toMatchObject({ banned: true })
  })
})

describe("clientKey", () => {
  it("takes the first forwarded address", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7")
    expect(clientKey(" 203.0.113.7 , 10.0.0.1")).toBe("203.0.113.7")
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  it("groups IPv6 by /64", () => {
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64")
    expect(clientKey("2001:DB8:1:2::9")).toBe("2001:db8:1:2::/64")
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(clientKey("2001:0db8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64")
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64")
  })

  it("falls back to one shared key without a forwarded address", () => {
    expect(clientKey(null)).toBe("unknown")
    expect(clientKey("")).toBe("unknown")
  })
})

describe("rateLimitProxy", () => {
  afterEach(() => vi.restoreAllMocks())

  const request = (headers: Record<string, string> = {}) => new NextRequest("https://cryptomarketbot.app/trades", { headers: { "x-forwarded-for": "198.51.100.4", ...headers } })

  it("passes requests through, then answers 429 with Retry-After", async () => {
    const isOwner = vi.fn(async () => true)
    const proxy = rateLimitProxy({ isOwner, limiter: new RateLimiter() })
    for (let i = 0; i < LIMITS.burst; i++) expect((await proxy(request())).status).toBe(200)
    const res = await proxy(request())
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("1")
    expect(res.headers.get("cache-control")).toBe("no-store")
    // No session cookie: the owner is never looked up.
    expect(isOwner).not.toHaveBeenCalled()
  })

  it("lets the owner's session through once over the limit", async () => {
    const isOwner = vi.fn(async () => true)
    const proxy = rateLimitProxy({ isOwner, limiter: new RateLimiter() })
    const cookie = { cookie: "__Secure-better-auth.session_token=abc.def" }
    for (let i = 0; i < LIMITS.burst + 50; i++) expect((await proxy(request(cookie))).status).toBe(200)
    expect(isOwner).toHaveBeenCalledTimes(1)
  })

  it("looks up a forged session once a minute at most, and logs the ban", async () => {
    const isOwner = vi.fn(async () => false)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const proxy = rateLimitProxy({ isOwner, limiter: new RateLimiter() })
    const cookie = { cookie: "better-auth.session_token=forged" }
    for (let i = 0; i < LIMITS.burst + LIMITS.banAfter + 20; i++) await proxy(request(cookie))
    expect(isOwner).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledExactlyOnceWith("[rate-limit] 198.51.100.4 banned for 60 min (ban 1 within a day)")
    expect((await proxy(request(cookie))).headers.get("retry-after")).toBe("3600")
  })

  it("refuses and logs when the owner check fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const proxy = rateLimitProxy({ isOwner: async () => Promise.reject(new Error("db down")), limiter: new RateLimiter() })
    const cookie = { cookie: "better-auth.session_token=abc" }
    for (let i = 0; i < LIMITS.burst; i++) await proxy(request(cookie))
    expect((await proxy(request(cookie))).status).toBe(429)
    expect(error).toHaveBeenCalledExactlyOnceWith("[rate-limit] owner check failed:", "db down")
  })

  it("counts a prefetch at a fifth", async () => {
    const proxy = rateLimitProxy({ isOwner: async () => false, limiter: new RateLimiter() })
    for (let i = 0; i < LIMITS.burst * 4; i++) expect((await proxy(request({ rsc: "1", "next-router-prefetch": "1" }))).status).toBe(200)
  })

  it("charges in full for prefetch headers that get page data", async () => {
    // Either header alone, or another value, is answered with the page itself.
    const variants: Record<string, string>[] = [{ "next-router-prefetch": "1" }, { rsc: "1" }, { rsc: "1", "next-router-prefetch": "2" }, { "next-router-segment-prefetch": "/_tree" }]
    for (const headers of variants) {
      const proxy = rateLimitProxy({ isOwner: async () => false, limiter: new RateLimiter() })
      for (let i = 0; i < LIMITS.burst; i++) await proxy(request(headers))
      expect((await proxy(request(headers))).status).toBe(429)
    }
  })
})
