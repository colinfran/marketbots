import "server-only"
import { isIP } from "node:net"
import { getSessionCookie } from "better-auth/cookies"
import { type NextRequest, NextResponse } from "next/server"

/**
 * Per-visitor rate limit and automatic bans for the dashboards, run by each app's proxy.ts on every
 * request but build assets and static files (docs/SERVER.md §8.6).
 *
 * A visitor (the address in Caddy's X-Forwarded-For; IPv6 by /64) has a bucket of 180 points that
 * refills at 3 a second. A request costs 1. A link prefetch costs 0.2: its answer holds no page data
 * (~230 bytes against 200-400 KB for the page), and Next makes dozens per page view. Measured in a
 * real browser (2026-11-08), the heaviest page view costs ~25 points and clicking a link every 2 s
 * ~70 a minute, so two or three readers behind one address stay under the limit, while a scraper is
 * held to 3 pages a second. An empty bucket answers 429.
 *
 * A visitor refused 100 points' worth within 10 minutes is banned: 1 hour, doubling with each ban
 * within a day of the last, up to 24 hours. The owner's session lifts the limit (and any ban) for its
 * address for an hour; it is looked up only once the address is over the limit, at most once a
 * minute per address, so forged cookies can't turn into database load.
 *
 * The state is this process's memory: each dashboard is one container, so there is nothing to share,
 * and a deploy clears it. Permanent bans are Caddy's (C:\Caddy\marketbots-banned.caddy, §8.6).
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
  /** The first ban; each further ban within `banMemoryMs` of the last one's end doubles it, up to `maxBanMs`. */
  banMs: number
  maxBanMs: number
  banMemoryMs: number
  /** How long the owner's session exempts its address. */
  ownerMs: number
  /** At most one owner lookup per address per this long. */
  ownerCheckMs: number
  /** Visitors remembered at most; the oldest unbanned go first. */
  maxEntries: number
}

export const LIMITS: Limits = {
  burst: 180,
  perSecond: 3,
  prefetchCost: 0.2,
  banAfter: 100,
  strikeWindowMs: 10 * MINUTE,
  banMs: HOUR,
  maxBanMs: 24 * HOUR,
  banMemoryMs: 24 * HOUR,
  ownerMs: HOUR,
  ownerCheckMs: MINUTE,
  maxEntries: 100_000,
}

type Entry = {
  tokens: number
  at: number
  strikes: number
  strikesSince: number
  bannedUntil: number
  bans: number
  ownerUntil: number
  ownerCheckedAt: number
}

export type Verdict =
  | { allowed: true }
  | {
      allowed: false
      /** Seconds until a request would be let through. */
      retryAfter: number
      banned: boolean
      /** Set on the request that earned a ban. */
      newBan?: { minutes: number; count: number }
    }

const ALLOWED: Verdict = { allowed: true }
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

export class RateLimiter {
  private readonly entries = new Map<string, Entry>()
  private sweptAt: number

  constructor(
    private readonly limits: Limits = LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.sweptAt = now()
  }

  /** Visitors remembered. */
  get size() {
    return this.entries.size
  }

  /** Spends a request's points from the visitor's bucket, or refuses it (and bans a visitor who keeps going). */
  take(key: string, prefetch = false): Verdict {
    const now = this.now()
    if (now - this.sweptAt >= MINUTE) this.sweep(now)
    const e = this.entry(key, now)
    if (e.ownerUntil > now) return ALLOWED
    if (e.bannedUntil > now) return { allowed: false, banned: true, retryAfter: seconds(e.bannedUntil - now) }
    const { burst, perSecond, prefetchCost, banAfter, strikeWindowMs, banMs, maxBanMs, banMemoryMs } = this.limits
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
    if (now - e.bannedUntil > banMemoryMs) e.bans = 0
    const ms = Math.min(maxBanMs, banMs * 2 ** e.bans)
    e.bans += 1
    e.bannedUntil = now + ms
    e.strikes = 0
    return { allowed: false, banned: true, retryAfter: seconds(ms), newBan: { minutes: ms / MINUTE, count: e.bans } }
  }

  /** Whether to look up the owner's session for this address now: at most once per `ownerCheckMs`. */
  shouldCheckOwner(key: string): boolean {
    const now = this.now()
    const e = this.entry(key, now)
    if (now - e.ownerCheckedAt < this.limits.ownerCheckMs) return false
    e.ownerCheckedAt = now
    return true
  }

  /** The owner is at this address: no limit for `ownerMs`, and any ban is lifted. */
  markOwner(key: string) {
    const now = this.now()
    const e = this.entry(key, now)
    e.ownerUntil = now + this.limits.ownerMs
    if (e.bannedUntil > now) e.bannedUntil = now
    e.bans = 0
    e.strikes = 0
    e.tokens = this.limits.burst
    e.at = now
  }

  private entry(key: string, now: number): Entry {
    let e = this.entries.get(key)
    if (!e) {
      e = { tokens: this.limits.burst, at: now, strikes: 0, strikesSince: -Infinity, bannedUntil: -Infinity, bans: 0, ownerUntil: -Infinity, ownerCheckedAt: -Infinity }
      this.entries.set(key, e)
      if (this.entries.size > this.limits.maxEntries) this.evict(key, now)
    }
    return e
  }

  /** Forgets the oldest visitor that isn't banned (or, if all are, the oldest). */
  private evict(keep: string, now: number) {
    let oldest: string | undefined
    for (const [key, e] of this.entries) {
      if (key === keep) continue
      oldest ??= key
      if (e.bannedUntil <= now) {
        this.entries.delete(key)
        return
      }
    }
    if (oldest !== undefined) this.entries.delete(oldest)
  }

  /** Forgets visitors with a full bucket, no recent refusals, no ban to remember and no owner exemption. */
  private sweep(now: number) {
    this.sweptAt = now
    const { burst, perSecond, strikeWindowMs, banMemoryMs } = this.limits
    for (const [key, e] of this.entries) {
      const full = e.tokens + ((now - e.at) / 1000) * perSecond >= burst
      const quiet = now - e.strikesSince > strikeWindowMs
      const remembered = now - e.bannedUntil <= banMemoryMs
      if (full && quiet && !remembered && e.ownerUntil <= now) this.entries.delete(key)
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

const tooMany = (retryAfter: number) =>
  new NextResponse("Too many requests. Wait a minute and try again.\n", {
    status: 429,
    headers: { "retry-after": String(retryAfter), "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  })

/**
 * The dashboard's proxy (proxy.ts): lets a request through or answers 429. `isOwner` is the auth
 * module's session check for a request's headers.
 */
export const rateLimitProxy =
  ({ isOwner, limiter = new RateLimiter() }: { isOwner: (headers: Headers) => Promise<boolean>; limiter?: RateLimiter }) =>
  async (request: NextRequest): Promise<NextResponse> => {
    const key = clientKey(request.headers.get("x-forwarded-for"))
    const verdict = limiter.take(key, isPrefetch(request.headers))
    if (verdict.allowed) return NextResponse.next()
    const owner = () =>
      isOwner(request.headers).catch((error: unknown) => {
        console.error("[rate-limit] owner check failed:", error instanceof Error ? error.message : String(error))
        return false
      })
    if (getSessionCookie(request) && limiter.shouldCheckOwner(key) && (await owner())) {
      limiter.markOwner(key)
      return NextResponse.next()
    }
    if (verdict.newBan) console.warn(`[rate-limit] ${key} banned for ${verdict.newBan.minutes} min (ban ${verdict.newBan.count} within a day)`)
    return tooMany(verdict.retryAfter)
  }
