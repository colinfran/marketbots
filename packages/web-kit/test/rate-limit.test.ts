import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type BanRecord, type BanStore, BanSync, type BlockedCounts, clientKey, LIMITS, type Limits, RateLimiter, rateLimitProxy, scannerProbe } from "../src/rate-limit"

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

/** Drains the bucket, then keeps going until the ban. */
const earnBan = (rl: RateLimiter, key: string) => {
  drain(rl, key)
  for (let i = 0; i < LIMITS.banAfter - 1; i++) expect(rl.take(key)).toMatchObject({ allowed: false, banned: false })
  return rl.take(key)
}

/** A store in memory, as the database would keep it. */
const memoryStore = (initial: string[] = []) => {
  const bans = new Set(initial)
  const added: BanRecord[] = []
  const blocked: BlockedCounts[] = []
  const store: BanStore = {
    load: vi.fn(async () => [...bans]),
    add: vi.fn(async (ban: BanRecord) => {
      bans.add(ban.key)
      added.push(ban)
    }),
    lift: vi.fn(async (key: string) => {
      bans.delete(key)
    }),
    recordBlocked: vi.fn(async (counts: BlockedCounts) => {
      blocked.push(counts)
    }),
  }
  return { bans, added, blocked, store }
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

  it("bans a visitor who keeps going after refusals, for good, and counts what it is refused", () => {
    const { rl, advance, now } = limiter()
    expect(earnBan(rl, "a")).toEqual({ allowed: false, banned: true, newBan: true })
    expect(rl.isBanned("a")).toBe(true)
    advance(365 * 24 * 60 * MINUTE)
    expect(rl.take("a")).toEqual({ allowed: false, banned: true, newBan: false })
    expect(rl.take("a", true)).toEqual({ allowed: false, banned: true, newBan: false })
    expect(rl.drainBlocked()).toEqual(new Map([["a", { count: 2, last: now() }]]))
    expect(rl.drainBlocked().size).toBe(0)
    expect(rl.reason).toBe("kept going while rate-limited: 100 requests refused within 10 minutes")
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

  it("lets the owner's address through and lifts its ban", () => {
    const { rl, advance } = limiter()
    earnBan(rl, "a")
    expect(rl.markOwner("a")).toBe(true)
    expect(rl.markOwner("a")).toBe(false)
    for (let i = 0; i < 1_000; i++) expect(rl.take("a").allowed).toBe(true)
    advance(LIMITS.ownerMs)
    // The exemption ends with a full bucket and no ban.
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

  it("forgets idle visitors' buckets but never a ban", () => {
    const { rl, advance } = limiter()
    rl.take("idle")
    earnBan(rl, "banned")
    expect(rl.size).toBe(2)
    advance(LIMITS.strikeWindowMs + 1)
    rl.take("trigger")
    expect(rl.size).toBe(1)
    expect(rl.take("banned")).toMatchObject({ banned: true })
  })

  it("caps the buckets it remembers", () => {
    const { rl } = limiter({ maxEntries: 3 })
    earnBan(rl, "banned")
    for (const key of ["b", "c", "d"]) rl.take(key)
    expect(rl.size).toBe(3)
    expect(rl.take("banned")).toMatchObject({ banned: true })
  })

  it("bans at once on a probe, but never the owner's exempt address", () => {
    const { rl, advance } = limiter()
    expect(rl.ban("a")).toBe(true)
    expect(rl.ban("a")).toBe(false)
    expect(rl.take("a")).toEqual({ allowed: false, banned: true, newBan: false })
    rl.markOwner("owner")
    expect(rl.ban("owner")).toBe(false)
    expect(rl.isBanned("owner")).toBe(false)
    advance(LIMITS.ownerMs)
    expect(rl.ban("owner")).toBe(true)
  })

  it("replaces its bans with the stored list, keeping the ones it is told to", () => {
    const { rl, advance } = limiter()
    earnBan(rl, "old")
    advance(MINUTE)
    earnBan(rl, "new")
    rl.replaceBans(["stored"], (key) => key === "new")
    expect(["old", "new", "stored"].map((k) => rl.isBanned(k))).toEqual([false, true, true])
  })
})

describe("BanSync", () => {
  afterEach(() => vi.useRealTimers())

  it("loads the stored bans before the first request", async () => {
    const { store } = memoryStore(["203.0.113.7"])
    const rl = new RateLimiter()
    await new BanSync(rl, store).ready()
    expect(rl.take("203.0.113.7")).toMatchObject({ banned: true })
  })

  it("reloads every minute without traffic: drops lifted bans, keeps its own unsaved ones, saves refused counts", async () => {
    vi.useFakeTimers()
    const { bans, blocked, store } = memoryStore(["lifted", "kept"])
    const rl = new RateLimiter()
    const sync = new BanSync(rl, store)
    await sync.ready()
    const refusedAt = Date.now()
    rl.take("kept")
    rl.take("kept")
    bans.delete("lifted") // Unban on the Admin page.
    // A ban whose save hasn't reached the store yet.
    let finish: () => void = () => {}
    vi.mocked(store.add).mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    expect(earnBan(rl, "fresh")).toMatchObject({ newBan: true })
    sync.banned({ key: "fresh", at: new Date(), reason: rl.reason, path: "/", userAgent: null })
    // No request comes: the timer reloads.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(store.load).toHaveBeenCalledTimes(2)
    expect(["lifted", "kept", "fresh"].map((k) => rl.isBanned(k))).toEqual([false, true, true])
    expect(blocked).toEqual([new Map([["kept", { count: 2, last: refusedAt }]])])
    finish()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(store.load).toHaveBeenCalledTimes(3)
    expect(blocked).toHaveLength(1) // Nothing refused since: nothing to save.
  })

  it("keeps its bans when the store can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { store } = memoryStore()
    const rl = new RateLimiter()
    const sync = new BanSync(rl, store)
    await sync.ready()
    earnBan(rl, "a")
    vi.mocked(store.load).mockRejectedValueOnce(new Error("db down"))
    await sync.run()
    expect(rl.isBanned("a")).toBe(true)
    expect(error).toHaveBeenCalledWith("[rate-limit] ban list not loaded:", "db down")
    error.mockRestore()
  })

  it("lets the first requests wait 3 seconds at most for the store", async () => {
    vi.useFakeTimers()
    const { store } = memoryStore()
    vi.mocked(store.load).mockImplementation(() => new Promise(() => {}))
    const sync = new BanSync(new RateLimiter(), store)
    let done = false
    void sync.ready().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2_900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toBe(true)
  })
})

describe("scannerProbe", () => {
  const none = new Headers()

  it("spots the paths scanners asked for in the access log", () => {
    const probes = [
      "/.env",
      "/.env.local",
      "/.env.production",
      "/.env~",
      "/backend/.env",
      "/var/www/html/.env",
      "/.git/config",
      "/.git/HEAD",
      "/.config/gcloud/application_default_credentials.json",
      "/.aws/credentials",
      "/.DS_Store",
      "/%2eenv",
      "/wp-admin/install.php",
      "/wp-config.php",
      "/info.php",
      "/phpinfo.php",
      "/xmlrpc.php",
      "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php",
      "/wp-login",
      "/wordpress/",
      "/phpmyadmin/index",
      "/cgi-bin/luci",
      "/default.aspx",
      "/credentials.json",
      "/gcp-credentials.json",
      "/google-credentials.json",
      "/service-account.json",
      "/firebase-adminsdk.json",
      "/secrets.yaml",
      "/key.json",
      "/keyfile.json",
      "/google-key.json",
      "/firebase-key.json",
      "/private_key.pem",
      "/terraform.tfstate",
      "/terraform.tfstate.backup",
      "/terraform.tfvars.json",
      "/cloudformation.yaml",
      "/serverless.yml",
      "/samconfig.toml",
      "/amplify.yml",
      "/cdk.json",
      "/docker-compose.prod.yml",
      "/id_rsa",
      "/id_ed25519.pub",
    ]
    expect(probes.filter((p) => !scannerProbe(p, none))).toEqual([])
    expect(scannerProbe("/.env", none)).toBe("scanner probe: a path only scanners request")
  })

  it("never takes a browser's request for one", () => {
    const pages = [
      "/",
      "/markets",
      "/markets/BTC-USD",
      "/markets/BRK.B",
      "/agent",
      "/agent/b8860848-6408-4974-a617-32a52288a8b4",
      "/decisions/88ae177c-ead7-48e4-95de-86212e5c1f00",
      "/journal/2026-11-12",
      "/holdings",
      "/news",
      "/admin/server",
      "/login",
      "/api/stream-token",
      "/api/auth/get-session",
      "/api/candles",
      "/api/host/commands/abc",
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
      "/sw.js",
      "/_next/static/chunks/3_ond1-x2a2sw.js.map",
      "/static/chunks/049914d_fk5xp.js",
      "/.well-known/appspecific/com.chrome.devtools.json",
      "/.well-known/security.txt",
      "/apple-touch-icon.png",
      "/monkey.json",
      "/%E0%A4%A",
    ]
    expect(pages.filter((p) => scannerProbe(p, none))).toEqual([])
  })

  it("takes any Next-Action header for a server-action probe", () => {
    expect(scannerProbe("/", new Headers({ "next-action": "x" }))).toBe("scanner probe: a server action (Next-Action header; the dashboards have none)")
    expect(scannerProbe("/markets", new Headers({ "Next-Action": "" }))).not.toBeNull()
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

  const request = (headers: Record<string, string> = {}, path = "/trades") =>
    new NextRequest(`https://cryptomarketbot.app${path}`, { headers: { "x-forwarded-for": "198.51.100.4", "user-agent": "scraper/1.0", ...headers } })

  it("passes requests through, then answers 429 with Retry-After", async () => {
    const isOwner = vi.fn(async () => true)
    const proxy = rateLimitProxy({ isOwner })
    for (let i = 0; i < LIMITS.burst; i++) expect((await proxy(request())).status).toBe(200)
    const res = await proxy(request())
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("1")
    expect(res.headers.get("cache-control")).toBe("no-store")
    // No session cookie: the owner is never looked up.
    expect(isOwner).not.toHaveBeenCalled()
  })

  it("bans for good with 403, logs and saves the ban once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { added, store } = memoryStore()
    const proxy = rateLimitProxy({ isOwner: async () => false, store })
    for (let i = 0; i < LIMITS.burst + LIMITS.banAfter - 1; i++) await proxy(request({}, "/markets/BTC-USD?x=1"))
    const res = await proxy(request({}, "/markets/BTC-USD?x=1"))
    expect(res.status).toBe(403)
    expect(res.headers.get("retry-after")).toBeNull()
    expect((await proxy(request())).status).toBe(403)
    expect(warn).toHaveBeenCalledExactlyOnceWith("[rate-limit] 198.51.100.4 banned for good: kept going while rate-limited: 100 requests refused within 10 minutes")
    await vi.waitFor(() => expect(added).toHaveLength(1))
    expect(added[0]).toMatchObject({ key: "198.51.100.4", path: "/markets/BTC-USD", userAgent: "scraper/1.0", reason: expect.stringContaining("100 requests") })
  })

  it("refuses an address banned before the start from its first request", async () => {
    const { store } = memoryStore(["198.51.100.4"])
    const proxy = rateLimitProxy({ isOwner: async () => false, store })
    expect((await proxy(request())).status).toBe(403)
    expect((await proxy(request({ "x-forwarded-for": "198.51.100.5" }))).status).toBe(200)
  })

  it("lets the owner's session through once over the limit, lifting a stored ban", async () => {
    const isOwner = vi.fn(async () => true)
    const { bans, store } = memoryStore(["198.51.100.4"])
    const proxy = rateLimitProxy({ isOwner, store })
    const cookie = { cookie: "__Secure-better-auth.session_token=abc.def" }
    for (let i = 0; i < LIMITS.burst + 50; i++) expect((await proxy(request(cookie))).status).toBe(200)
    expect(isOwner).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(bans.has("198.51.100.4")).toBe(false))
  })

  it("looks up a forged session once a minute at most", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const isOwner = vi.fn(async () => false)
    const proxy = rateLimitProxy({ isOwner })
    const cookie = { cookie: "better-auth.session_token=forged" }
    for (let i = 0; i < LIMITS.burst + LIMITS.banAfter + 20; i++) await proxy(request(cookie))
    expect(isOwner).toHaveBeenCalledTimes(1)
    expect((await proxy(request(cookie))).status).toBe(403)
  })

  it("refuses and logs when the owner check fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const proxy = rateLimitProxy({ isOwner: async () => Promise.reject(new Error("db down")) })
    const cookie = { cookie: "better-auth.session_token=abc" }
    for (let i = 0; i < LIMITS.burst; i++) await proxy(request(cookie))
    expect((await proxy(request(cookie))).status).toBe(429)
    expect(error).toHaveBeenCalledExactlyOnceWith("[rate-limit] owner check failed:", "db down")
  })

  it("bans a scanner's probe on its first request: 404, logged, saved, then 403 for everything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { added, store } = memoryStore()
    const proxy = rateLimitProxy({ isOwner: async () => false, store })
    expect((await proxy(request())).status).toBe(200)
    const res = await proxy(request({}, "/backend/.env?x=1"))
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await proxy(request())).status).toBe(403)
    expect((await proxy(request({}, "/.git/config"))).status).toBe(403)
    expect(warn).toHaveBeenCalledExactlyOnceWith("[rate-limit] 198.51.100.4 banned for good: scanner probe: a path only scanners request (/backend/.env)")
    await vi.waitFor(() => expect(added).toHaveLength(1))
    expect(added[0]).toMatchObject({ key: "198.51.100.4", path: "/backend/.env", userAgent: "scraper/1.0", reason: "scanner probe: a path only scanners request" })
    // Another address is untouched.
    expect((await proxy(request({ "x-forwarded-for": "198.51.100.5" }))).status).toBe(200)
  })

  it("bans a server-action probe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { added, store } = memoryStore()
    const proxy = rateLimitProxy({ isOwner: async () => false, store })
    const probe = new NextRequest("https://cryptomarketbot.app/", { method: "POST", body: "{}", headers: { "x-forwarded-for": "198.51.100.4", "next-action": "x" } })
    expect((await proxy(probe)).status).toBe(404)
    expect((await proxy(request())).status).toBe(403)
    await vi.waitFor(() => expect(added).toHaveLength(1))
    expect(added[0].reason).toContain("Next-Action")
  })

  it("answers the owner's exempt address 404 for a probe, without a ban", async () => {
    const { added, store } = memoryStore()
    const proxy = rateLimitProxy({ isOwner: async () => true, store })
    const cookie = { cookie: "__Secure-better-auth.session_token=abc.def" }
    // Over the limit once, so the owner's session is looked up and exempts the address.
    for (let i = 0; i <= LIMITS.burst; i++) expect((await proxy(request(cookie))).status).toBe(200)
    expect((await proxy(request(cookie, "/.env"))).status).toBe(404)
    expect((await proxy(request(cookie))).status).toBe(200)
    expect(added).toEqual([])
  })

  it("counts a prefetch at a fifth", async () => {
    const proxy = rateLimitProxy({ isOwner: async () => false })
    for (let i = 0; i < LIMITS.burst * 4; i++) expect((await proxy(request({ rsc: "1", "next-router-prefetch": "1" }))).status).toBe(200)
  })

  it("charges in full for prefetch headers that get page data", async () => {
    // Either header alone, or another value, is answered with the page itself.
    const variants: Record<string, string>[] = [{ "next-router-prefetch": "1" }, { rsc: "1" }, { rsc: "1", "next-router-prefetch": "2" }, { "next-router-segment-prefetch": "/_tree" }]
    for (const headers of variants) {
      const proxy = rateLimitProxy({ isOwner: async () => false })
      for (let i = 0; i < LIMITS.burst; i++) await proxy(request(headers))
      expect((await proxy(request(headers))).status).toBe(429)
    }
  })
})
