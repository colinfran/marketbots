/**
 * robots.txt for POST /extract (MARKETBOTS_PLAN §3.8). Only the `User-agent: *` group is read: the
 * scraper fetches one article per news item, so it follows the rules every crawler gets. Rules are
 * matched the RFC 9309 way: `*` matches any run of characters, a trailing `$` anchors the end, the
 * longest matching pattern wins and Allow wins a tie. A robots.txt that can't be fetched (network
 * error, 4xx, 5xx, not text) counts as "everything allowed". Each origin's answer is cached for
 * 24 h, failures included, and concurrent lookups for one origin share a single fetch.
 */

const TTL_MS = 24 * 3_600_000
const TIMEOUT_MS = 5_000
const MAX_BYTES = 512_000
const MAX_ORIGINS = 2_000

/** The `User-agent: *` rules of a robots.txt, as [{ allow, pattern }]. */
export const parseRobots = (text) => {
  const rules = []
  let inStar = false
  let lastWasAgent = false
  for (const line of String(text).split(/\r?\n|\r/)) {
    const content = line.replace(/#.*$/, "").trim()
    const colon = content.indexOf(":")
    if (colon < 1) continue
    const field = content.slice(0, colon).trim().toLowerCase()
    const value = content.slice(colon + 1).trim()
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; a new run starts a new group.
      if (!lastWasAgent) inStar = false
      if (value === "*") inStar = true
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!inStar || (field !== "allow" && field !== "disallow")) continue
    // An empty Disallow allows everything: it adds no rule.
    if (!value) continue
    rules.push({ allow: field === "allow", pattern: value })
  }
  return rules
}

const toRegExp = (pattern) => {
  const anchored = pattern.endsWith("$")
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${body}${anchored ? "$" : ""}`)
}

/** Whether `path` (pathname + search) may be fetched under `rules`. /robots.txt is always allowed. */
export const isAllowed = (rules, path) => {
  if (path === "/robots.txt") return true
  let best = null
  for (const rule of rules) {
    if (!toRegExp(rule.pattern).test(path)) continue
    const longer = !best || rule.pattern.length > best.pattern.length
    const tieAllow = best && rule.pattern.length === best.pattern.length && rule.allow && !best.allow
    if (longer || tieAllow) best = rule
  }
  return best ? best.allow : true
}

/**
 * A robots.txt cache. `allowed(url)` resolves to true or false and never throws.
 * `fetch` is injectable for tests; `now` too.
 */
export const createRobots = ({ fetch = globalThis.fetch, userAgent, now = Date.now, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS } = {}) => {
  const cache = new Map()

  const load = async (origin) => {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": userAgent ?? "Mozilla/5.0", accept: "text/plain,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return []
      }
      // A soft-404 HTML page parses to no rules, so the content type needn't be checked.
      const text = await res.text()
      return parseRobots(text.slice(0, MAX_BYTES))
    } catch {
      return []
    }
  }

  const rulesFor = (origin) => {
    const hit = cache.get(origin)
    if (hit && now() - hit.at < ttlMs) return hit.rules
    const rules = load(origin)
    // Oldest first: Map keeps insertion order, so deleting before setting moves an origin to the end.
    cache.delete(origin)
    cache.set(origin, { at: now(), rules })
    while (cache.size > MAX_ORIGINS) cache.delete(cache.keys().next().value)
    return rules
  }

  return {
    allowed: async (url) => {
      const u = new URL(url)
      const rules = await rulesFor(u.origin)
      return isAllowed(rules, `${u.pathname}${u.search}`)
    },
    get size() {
      return cache.size
    },
  }
}
