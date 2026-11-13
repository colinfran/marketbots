import "server-only"
import { isIP } from "node:net"
import { getSessionCookie } from "better-auth/cookies"
import { type NextRequest, NextResponse } from "next/server"

/**
 * Per-visitor rate limit and permanent bans for the dashboards, run by each app's proxy.ts on every
 * request but build assets and static files (docs/SERVER.md §8.6).
 *
 * A visitor (the address in Caddy's X-Forwarded-For; IPv6 by /64) has a bucket of 180 points that
 * refills at 3 a second. A request costs 1. A link prefetch costs 0.2: its answer holds no page data
 * (~230 bytes against 200-400 KB for the page), and Next makes dozens per page view. Measured in a
 * real browser (2026-11-08), the heaviest page view costs ~25 points and clicking a link every 2 s
 * ~70 a minute, so two or three readers behind one address stay under the limit, while a scraper is
 * held to 3 pages a second. An empty bucket answers 429.
 *
 * A visitor refused 100 points' worth within 10 minutes is banned for good: 403 on every request
 * until the owner lifts it on the Admin page. Bans are kept in the bot's database (`BanStore`,
 * @mb/web-kit/bans), so they survive deploys; `BanSync` loads them and picks up unbans. The owner's
 * session lifts the limit (and a ban) for its address for an hour; it is looked up only once the
 * address is over the limit, at most once a minute per address, so forged cookies can't turn into
 * database load.
 *
 * A scanner's probe (`scannerProbe`: a path no browser asks a dashboard for, or a server action)
 * earns the same ban on its first request, answered 404.
 *
 * The buckets are this process's memory: each dashboard is one container, and a deploy clears them.
 * Caddy's ban list (C:\Caddy\marketbots-banned.caddy, §8.6) blocks an address on every site at once.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export type Limits = {
  /** Bucket size, in points. */
  burst: number
  /** Points refilled per second. */
  perSecond: number
  /** A link prefetch's cost (a request costs 1). */
  prefetchCost: number
  /** Refused points within `strikeWindowMs` that earn a ban. */
  banAfter: number
  strikeWindowMs: number
  /** How long the owner's session exempts its address. */
  ownerMs: number
  /** At most one owner lookup per address per this long. */
  ownerCheckMs: number
  /** Visitors whose buckets are remembered at most; the oldest go first. */
  maxEntries: number
}

export const LIMITS: Limits = {
  burst: 180,
  perSecond: 3,
  prefetchCost: 0.2,
  banAfter: 100,
  strikeWindowMs: 10 * MINUTE,
  ownerMs: HOUR,
  ownerCheckMs: MINUTE,
  maxEntries: 100_000,
}

type Entry = {
  tokens: number
  at: number
  strikes: number
  strikesSince: number
  ownerUntil: number
  ownerCheckedAt: number
}

export type Verdict =
  | { allowed: true }
  | { allowed: false; banned: false; retryAfter: number }
  | { allowed: false; banned: true; newBan: boolean }

/** Requests refused from banned addresses since the last drain: how many, and the last one's time. */
export type BlockedCounts = Map<string, { count: number; last: number }>

const ALLOWED: Verdict = { allowed: true }
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

export class RateLimiter {
  private readonly entries = new Map<string, Entry>()
  /** Banned addresses, with when this process banned or loaded each. */
  private banned = new Map<string, number>()
  private blocked: BlockedCounts = new Map()
  private sweptAt: number

  constructor(
    private readonly limits: Limits = LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.sweptAt = now()
  }

  /** Why an address was banned, as stored and shown on the Admin page. */
  get reason() {
    return `kept going while rate-limited: ${this.limits.banAfter} requests refused within ${this.limits.strikeWindowMs / MINUTE} minutes`
  }

  /** Visitors whose buckets are remembered. */
  get size() {
    return this.entries.size
  }

  isBanned(key: string) {
    return this.banned.has(key)
  }

  /** Spends a request's points from the visitor's bucket, or refuses it (and bans a visitor who keeps going). */
  take(key: string, prefetch = false): Verdict {
    const now = this.now()
    if (now - this.sweptAt >= MINUTE) this.sweep(now)
    const e = this.entry(key, now)
    if (e.ownerUntil > now) return ALLOWED
    if (this.banned.has(key)) {
      this.blocked.set(key, { count: (this.blocked.get(key)?.count ?? 0) + 1, last: now })
      return { allowed: false, banned: true, newBan: false }
    }
    const { burst, perSecond, prefetchCost, banAfter, strikeWindowMs } = this.limits
    const cost = prefetch ? prefetchCost : 1
    e.tokens = Math.min(burst, e.tokens + ((now - e.at) / 1000) * perSecond)
    e.at = now
    if (e.tokens >= cost) {
      e.tokens -= cost
      return ALLOWED
    }
    if (now - e.strikesSince > strikeWindowMs) {
      e.strikes = 0
      e.strikesSince = now
    }
    e.strikes += cost
    if (e.strikes < banAfter) return { allowed: false, banned: false, retryAfter: seconds(((cost - e.tokens) / perSecond) * 1000) }
    e.strikes = 0
    this.banned.set(key, now)
    return { allowed: false, banned: true, newBan: true }
  }

  /** Bans an address at once (a scanner's probe). False when it is banned already or exempt as the owner's. */
  ban(key: string): boolean {
    const now = this.now()
    if (this.banned.has(key) || this.entry(key, now).ownerUntil > now) return false
    this.banned.set(key, now)
    return true
  }

  /** Whether to look up the owner's session for this address now: at most once per `ownerCheckMs`. */
  shouldCheckOwner(key: string): boolean {
    const now = this.now()
    const e = this.entry(key, now)
    if (now - e.ownerCheckedAt < this.limits.ownerCheckMs) return false
    e.ownerCheckedAt = now
    return true
  }

  /** The owner is at this address: no limit for `ownerMs`. True when that lifted a ban. */
  markOwner(key: string): boolean {
    const now = this.now()
    const e = this.entry(key, now)
    e.ownerUntil = now + this.limits.ownerMs
    e.strikes = 0
    e.tokens = this.limits.burst
    e.at = now
    this.blocked.delete(key)
    return this.banned.delete(key)
  }

  /** The refused requests from banned addresses since the last call. */
  drainBlocked(): BlockedCounts {
    const out = this.blocked
    this.blocked = new Map()
    return out
  }

  /**
   * Replaces the bans with the stored list, so a ban lifted on the Admin page drops out, but keeps a
   * ban of this process's own that the store may not have yet (`keep`).
   */
  replaceBans(stored: Iterable<string>, keep: (key: string, since: number) => boolean) {
    const now = this.now()
    const next = new Map<string, number>()
    for (const key of stored) next.set(key, this.banned.get(key) ?? now)
    for (const [key, since] of this.banned) if (!next.has(key) && keep(key, since)) next.set(key, since)
    this.banned = next
  }

  private entry(key: string, now: number): Entry {
    let e = this.entries.get(key)
    if (!e) {
      e = { tokens: this.limits.burst, at: now, strikes: 0, strikesSince: -Infinity, ownerUntil: -Infinity, ownerCheckedAt: -Infinity }
      this.entries.set(key, e)
      if (this.entries.size > this.limits.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined && oldest !== key) this.entries.delete(oldest)
      }
    }
    return e
  }

  /** Forgets visitors with a full bucket, no recent refusals and no owner exemption. */
  private sweep(now: number) {
    this.sweptAt = now
    const { burst, perSecond, strikeWindowMs } = this.limits
    for (const [key, e] of this.entries) {
      const full = e.tokens + ((now - e.at) / 1000) * perSecond >= burst
      const quiet = now - e.strikesSince > strikeWindowMs
      if (full && quiet && e.ownerUntil <= now) this.entries.delete(key)
    }
  }
}

/** A ban as the proxy reports it to the store. */
export type BanRecord = { key: string; at: Date; reason: string; path: string | null; userAgent: string | null }

/** Where bans are kept (the bot's database: @mb/web-kit/bans). */
export type BanStore = {
  /** Every banned address. */
  load: () => Promise<string[]>
  add: (ban: BanRecord) => Promise<void>
  /** The owner's session came from a banned address: the ban goes. */
  lift: (key: string) => Promise<void>
  recordBlocked: (counts: BlockedCounts) => Promise<void>
}

const SYNC_MS = MINUTE
/** How long the first requests after a start wait for the stored bans. */
const FIRST_LOAD_WAIT_MS = 3_000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Keeps the limiter's bans and the store in step. The first requests after a start wait for the
 * stored list (3 s at most); then a timer reads it again every minute, traffic or not, which picks
 * up the Admin page's unbans and saves the counts of refused requests. A new ban is saved at once.
 */
export class BanSync {
  private first: Promise<void> | null = null
  private firstStarted = 0
  private firstDone = false
  private running = false
  /** Bans being saved: kept even if a reload that started before the save doesn't list them. */
  private readonly saving = new Set<string>()

  constructor(
    private readonly limiter: RateLimiter,
    private readonly store: BanStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call before each request: the first call loads the bans and starts the timer; the first requests wait for the load. */
  async ready(): Promise<void> {
    if (!this.first) {
      this.firstStarted = this.now()
      this.first = this.run().finally(() => {
        this.firstDone = true
      })
      const timer = setInterval(() => {
        if (!this.running) void this.run()
      }, SYNC_MS)
      // Never keeps the process alive on its own.
      ;(timer as { unref?: () => void }).unref?.()
    }
    if (this.firstDone) return
    const wait = this.firstStarted + FIRST_LOAD_WAIT_MS - this.now()
    if (wait > 0) await Promise.race([this.first, new Promise((resolve) => setTimeout(resolve, wait))])
  }

  banned(ban: BanRecord) {
    this.saving.add(ban.key)
    this.store
      .add(ban)
      .catch((error: unknown) => console.error(`[rate-limit] ban of ${ban.key} not saved:`, message(error)))
      .finally(() => this.saving.delete(ban.key))
  }

  lifted(key: string) {
    this.store.lift(key).catch((error: unknown) => console.error(`[rate-limit] lifted ban of ${key} not removed:`, message(error)))
  }

  /** The reload, awaited by tests. */
  async run() {
    this.running = true
    const started = this.now()
    try {
      const counts = this.limiter.drainBlocked()
      if (counts.size) await this.store.recordBlocked(counts).catch((error: unknown) => console.error("[rate-limit] refused-request counts not saved:", message(error)))
      const stored = await this.store.load()
      this.limiter.replaceBans(stored, (key, since) => since >= started || this.saving.has(key))
    } catch (error) {
      console.error("[rate-limit] ban list not loaded:", message(error))
    } finally {
      this.running = false
    }
  }
}

/** Groups of an IPv6 address's first 64 bits, as one key: a visitor gets a whole /64 to rotate through. */
const v6Prefix = (ip: string) => {
  const [head, tail] = ip.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`
}

/**
 * The visitor's key: the first address in X-Forwarded-For, which Caddy sets to the visitor's address
 * (replacing any the visitor sent). IPv4-mapped IPv6 counts as the IPv4 address, other IPv6 by /64.
 */
export const clientKey = (forwardedFor: string | null): string => {
  const ip = (forwardedFor ?? "").split(",")[0].trim().replace(/%.*$/, "")
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIP(ip) === 6) return v6Prefix(ip.toLowerCase())
  return ip || "unknown"
}

/**
 * A link prefetch, as Next's router sends it: both headers, exactly. Next answers that with the
 * route's shell only (~230 bytes, whatever segment is asked for); either header alone, or another
 * value, gets page data, so it costs a full request. Next hides these headers from the proxy unless
 * next.config sets skipProxyUrlNormalize.
 */
const isPrefetch = (h: Headers) => h.get("rsc") === "1" && h.get("next-router-prefetch") === "1"

/**
 * Paths only scanners ask a dashboard for, from what they asked for in Caddy's access log: a dot
 * file or folder anywhere but /.well-known (/.env, /backend/.env, /.git/config), server scripts,
 * WordPress and phpMyAdmin, cloud credential files and deployment files. Not here, because a
 * browser can ask for them: source maps (DevTools), /sw.js, /.well-known/… and every other 404.
 */
export const SCANNER_PATHS: readonly RegExp[] = [
  /\/\.(?!well-known(?:\/|$))[^/]/,
  /\.(?:php\d?|phtml|aspx?|jsp|cgi)(?:\/|$)/i,
  /\/(?:wp-(?:admin|content|includes|login|json)|wordpress|phpmyadmin|cgi-bin)(?:\/|$)/i,
  /\/[^/]*(?:credential|secret|service[-_]?account|adminsdk|keyfile)[^/]*\.(?:json|ya?ml|toml|txt|ini|xml)$/i,
  /\/(?:[\w-]*[-_])?keys?\.(?:json|pem)$/i,
  /\/(?:terraform\.tfstate[^/]*|[^/]*\.tfvars(?:\.json)?|cloudformation\.(?:json|ya?ml)|serverless\.ya?ml|samconfig\.toml|amplify\.ya?ml|cdk\.json|docker-compose[^/]*\.ya?ml|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i,
]

/**
 * Why a request can only be a scanner's, as the ban's reason, or null. The dashboards have no
 * server actions, so a Next-Action header probes Next's server-action decoder (Caddy refuses those
 * before they get here; this is the backstop). The path is matched decoded, as scanners also send
 * /%2eenv.
 */
export const scannerProbe = (pathname: string, headers: Headers): string | null => {
  if (headers.has("next-action")) return "scanner probe: a server action (Next-Action header; the dashboards have none)"
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // Malformed escapes: match the path as sent.
  }
  return SCANNER_PATHS.some((re) => re.test(path)) ? "scanner probe: a path only scanners request" : null
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new NextResponse(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } })

const tooMany = (retryAfter: number) => text(429, "Too many requests. Wait a minute and try again.\n", { "retry-after": String(retryAfter) })

const forbidden = () => text(403, "This address is blocked from this site for sending too many requests.\n")

const notFound = () => text(404, "Not found.\n")

/**
 * The dashboard's proxy (proxy.ts): lets a request through, or answers 429 (over the limit), 403
 * (banned) or 404 (a scanner's probe, which bans). `isOwner` is the auth module's session check for
 * a request's headers; `store` keeps the bans across deploys.
 */
export const rateLimitProxy = ({ isOwner, store, limiter = new RateLimiter() }: { isOwner: (headers: Headers) => Promise<boolean>; store?: BanStore; limiter?: RateLimiter }) => {
  const sync = store ? new BanSync(limiter, store) : null
  const record = (request: NextRequest, key: string, reason: string): BanRecord => ({
    key,
    at: new Date(),
    reason,
    path: request.nextUrl.pathname.slice(0, 300),
    userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
  })
  return async (request: NextRequest): Promise<NextResponse> => {
    await sync?.ready()
    const key = clientKey(request.headers.get("x-forwarded-for"))
    // A banned address's probe is refused (and counted) like its other requests, below.
    const probe = limiter.isBanned(key) ? null : scannerProbe(request.nextUrl.pathname, request.headers)
    if (probe) {
      if (limiter.ban(key)) {
        console.warn(`[rate-limit] ${key} banned for good: ${probe} (${request.nextUrl.pathname.slice(0, 120)})`)
        sync?.banned(record(request, key, probe))
      }
      return notFound()
    }
    const verdict = limiter.take(key, isPrefetch(request.headers))
    if (verdict.allowed) return NextResponse.next()
    const owner = () =>
      isOwner(request.headers).catch((error: unknown) => {
        console.error("[rate-limit] owner check failed:", message(error))
        return false
      })
    if (getSessionCookie(request) && limiter.shouldCheckOwner(key) && (await owner())) {
      if (limiter.markOwner(key)) sync?.lifted(key)
      return NextResponse.next()
    }
    if (!verdict.banned) return tooMany(verdict.retryAfter)
    if (verdict.newBan) {
      console.warn(`[rate-limit] ${key} banned for good: ${limiter.reason}`)
      sync?.banned(record(request, key, limiter.reason))
    }
    return forbidden()
  }
}
