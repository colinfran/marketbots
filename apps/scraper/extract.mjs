import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"

/**
 * POST /extract (MARKETBOTS_PLAN §3.8): one news article as plain text, for the engines' article
 * summaries (§3.9). Nothing is stored.
 *
 *   POST /extract { url, render?: "auto" | "never" | "always", skip_domains?: string[], max_chars? }
 *     → { status: "ok", url, final_url, title, byline, published, lang, text, words, rendered, truncated }
 *     | { status: "skipped" | "failed", reason }
 *
 * Order: the skip list (paywalls + the caller's skip_domains) and robots.txt are checked first, and
 * again on every redirect hop, so a refused page is never fetched. Then a plain fetch (browser
 * User-Agent, 15 s, 5 MB cap). With render "auto" a page whose text comes out short (or that
 * refuses plain fetches with 401/403) is rendered in headless Chromium through the same queue as
 * /render; "always" renders straight away, "never" never does. Navigation, dialogs and consent
 * banners are removed, then Mozilla Readability on a linkedom document picks the article; its text
 * keeps paragraph breaks ("\n\n") and collapses all other whitespace. Text that is mostly short
 * lines (link lists, footers, ad-blocker walls) is not an article, and a text that asks the reader to
 * subscribe is "skipped" as a paywall teaser. `words` counts the whole article, `text` is cut to
 * max_chars (default 20,000).
 */

// Keep the Chrome major in step with the Playwright image (apps/scraper/Dockerfile).
export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

/** Paywalled or scraping-hostile sites, refused with their subdomains. Callers add their own. */
export const DEFAULT_SKIP_DOMAINS = ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "seekingalpha.com"]

const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 5_000_000
const MAX_REDIRECTS = 5
const DEFAULT_MAX_CHARS = 20_000
const MIN_MAX_CHARS = 200
const MAX_MAX_CHARS = 100_000
const MAX_SKIP_DOMAINS = 200
/** Below this many words the plain fetch is "short" and "auto" tries a render. */
export const SHORT_WORDS = 150
/** Below this many words there is no article to return. */
export const MIN_WORDS = 50
/** Below this share of words in sentence-like paragraphs (proseShare) it isn't article text. */
export const MIN_PROSE = 0.6
const RENDER_ON_STATUS = new Set([401, 403])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const RENDER_MODES = new Set(["auto", "never", "always"])

const clean = (s, max = 500) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return t ? t.slice(0, max) : null
}

const normalizeDomain = (d) =>
  String(d)
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "")

/** The request body as an extract job, or a reason it isn't one. */
export const parseExtractJob = (raw) => {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { error: "body is not JSON" }
  }
  let url
  try {
    url = new URL(String(body?.url ?? ""))
  } catch {
    return { error: "url is not a URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "only http and https URLs are extracted" }
  const render = body.render ?? "auto"
  if (!RENDER_MODES.has(render)) return { error: 'render must be "auto", "never" or "always"' }
  const skip_domains = Array.isArray(body.skip_domains)
    ? body.skip_domains
        .filter((d) => typeof d === "string")
        .map(normalizeDomain)
        .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))
        .slice(0, MAX_SKIP_DOMAINS)
    : []
  const n = Number(body.max_chars)
  const max_chars = Number.isFinite(n) && n > 0 ? Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(n))) : DEFAULT_MAX_CHARS
  url.hash = ""
  return { job: { url: url.toString(), render, skip_domains, max_chars } }
}

/** The skip-list entry that covers `host` (the domain itself or a subdomain), else null. */
export const skippedDomain = (host, extra = []) => {
  const h = normalizeDomain(host)
  for (const d of [...DEFAULT_SKIP_DOMAINS, ...extra]) if (h === d || h.endsWith(`.${d}`)) return d
  return null
}

const privateIPv4 = (host) => {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Hosts the scraper must never fetch for a caller: loopback, private and link-local addresses,
 * and single-label names (the compose services: llm, crypto-engine…). URLs come from news feeds.
 */
export const privateHost = (hostname) => {
  const h = hostname.toLowerCase().replace(/\.$/, "")
  if (h.startsWith("[")) return /^\[(::1?|f[cd][0-9a-f]*:.*|fe[89ab][0-9a-f]*:.*|::ffff:.*)\]$/.test(h)
  if (privateIPv4(h)) return true
  return !h.includes(".") || h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)
}

/** Why `url` must not be fetched (as a "skipped" reason), else null. */
const refusal = (url, skip_domains) => {
  const u = new URL(url)
  if (u.protocol !== "http:" && u.protocol !== "https:") return `not http(s): ${u.protocol}`
  if (privateHost(u.hostname)) return `private address: ${u.hostname}`
  const d = skippedDomain(u.hostname, skip_domains)
  return d ? `skip list: ${d}` : null
}

// ── Article extraction (pure: HTML in, article out) ─────────────────────────────────────────────

const BLOCK = new Set(
  "address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody tfoot thead tr ul".split(" "),
)
const DROP = new Set("script style noscript template svg canvas iframe object embed button select textarea input math".split(" "))

/** Plain text of an element: paragraphs separated by a blank line, all other whitespace collapsed. */
export const toPlainText = (root) => {
  const paragraphs = []
  let buf = ""
  const flush = () => {
    const p = buf
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
    if (p) paragraphs.push(p)
    buf = ""
  }
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) buf += child.textContent.replace(/\s+/g, " ")
      else if (child.nodeType === 1) {
        const tag = child.localName?.toLowerCase() ?? ""
        if (DROP.has(tag)) continue
        if (tag === "br") buf += "\n"
        else if (tag === "td" || tag === "th") {
          walk(child)
          buf += " "
        } else if (BLOCK.has(tag)) {
          flush()
          walk(child)
          flush()
        } else walk(child)
      }
    }
  }
  walk(root)
  flush()
  return paragraphs.join("\n\n")
}

export const countWords = (text) => (text.match(/\S+/g) ?? []).length

const isoDate = (value) => {
  if (typeof value !== "string" || !value.trim()) return null
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const PUBLISHED_META = [
  "article:published_time",
  "og:article:published_time",
  "datepublished",
  "parsely-pub-date",
  "sailthru.date",
  "article.published",
  "publishdate",
  "publish-date",
  "pubdate",
  "dc.date.issued",
  "dcterms.created",
  "dc.date",
  "date",
]
const ARTICLE_TYPES = /^(NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting|Report|WebPage)$/

/** All JSON-LD objects on the page, flattened through arrays and @graph. */
const jsonLd = (document) => {
  const out = []
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6 || out.length > 200) return
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1))
    out.push(node)
    if (node["@graph"]) visit(node["@graph"], depth + 1)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent), 0)
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  }
  return out
}

const metaMap = (document) => {
  const map = new Map()
  for (const meta of document.querySelectorAll("meta")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? meta.getAttribute("itemprop") ?? meta.getAttribute("http-equiv") ?? "").trim().toLowerCase()
    const content = meta.getAttribute("content")
    if (key && content && !map.has(key)) map.set(key, content)
  }
  return map
}

/** The publish date as ISO 8601: meta tags, then JSON-LD datePublished, then a <time> element. */
export const findPublished = (document, metas = metaMap(document), ld = jsonLd(document)) => {
  for (const key of PUBLISHED_META) {
    const d = isoDate(metas.get(key))
    if (d) return d
  }
  const typed = ld.filter((o) => [o["@type"]].flat().some((t) => ARTICLE_TYPES.test(String(t))))
  for (const o of [...typed, ...ld]) {
    const d = isoDate(o.datePublished)
    if (d) return d
  }
  const time =
    document.querySelector("time[pubdate][datetime]") ??
    document.querySelector('time[itemprop="datePublished"][datetime]') ??
    document.querySelector("article time[datetime]") ??
    document.querySelector("time[datetime]")
  return isoDate(time?.getAttribute("datetime"))
}

/** The page language: <html lang>, else Content-Language, else og:locale. */
export const findLang = (document, metas = metaMap(document)) => {
  const html = document.documentElement
  const raw = html?.getAttribute("lang") || html?.getAttribute("xml:lang") || metas.get("content-language") || metas.get("og:locale")?.replace("_", "-")
  return clean(raw?.split(",")[0], 35)
}

const CLUTTER = 'nav, dialog, [role="navigation"], [role="search"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
const CONSENT = /cookie|consent|gdpr|onetrust|didomi|truste|cmp-|skip-?link|skip-to/i
const KEEP = new Set(["html", "body", "main", "article"])

/**
 * Removes navigation, dialogs and cookie/consent banners, which Readability sometimes keeps
 * (it judges containers by class names and text density, and a consent banner can be dense).
 */
const declutter = (document) => {
  for (const el of document.querySelectorAll(CLUTTER)) el.remove()
  for (const el of document.querySelectorAll("[id], [class]")) {
    const tag = el.localName?.toLowerCase()
    if (KEEP.has(tag) || !CONSENT.test(`${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`)) continue
    if ((el.textContent ?? "").length < 3_000) el.remove()
  }
}

const authorOf = (ld) => {
  for (const o of ld) {
    const names = [o.author]
      .flat()
      .map((a) => (typeof a === "string" ? a : a?.name))
      .filter((n) => typeof n === "string" && n.trim())
    if (names.length) return names.join(", ")
  }
  return null
}

/**
 * The share of words that sit in sentence-like paragraphs (12+ words). Articles score 0.8–1; link
 * lists, footers and ad-blocker walls that Readability sometimes returns score well under 0.6.
 */
export const proseShare = (text) => {
  let total = 0
  let prose = 0
  for (const p of text.split("\n\n")) {
    const n = countWords(p)
    total += n
    if (n >= 12) prose += n
  }
  return total ? prose / total : 0
}

/**
 * The article in an HTML page: { title, byline, published, lang, text, words, prose }, or null
 * when Readability finds nothing. `url` resolves relative links and is Readability's base URI.
 */
export const extractArticle = (html, url) => {
  let document
  try {
    ;({ document } = parseHTML(html))
  } catch {
    return null
  }
  if (!document?.documentElement || !document.firstChild) return null
  // Metadata first: Readability rewrites the document as it works.
  const metas = metaMap(document)
  const ld = jsonLd(document)
  const published = findPublished(document, metas, ld)
  const lang = findLang(document, metas)
  const fallbackTitle = metas.get("og:title") ?? document.querySelector("title")?.textContent
  const fallbackByline = metas.get("author") ?? authorOf(ld)
  let article
  try {
    declutter(document)
    article = new Readability(document, { serializer: (el) => el }).parse()
  } catch {
    return null
  }
  if (!article?.content) return null
  const text = toPlainText(article.content)
  if (!text) return null
  return {
    title: clean(article.title || fallbackTitle),
    byline: clean((article.byline || fallbackByline || "").replace(/^\s*by\s+/i, ""), 200),
    published: published ?? isoDate(article.publishedTime),
    lang: lang ?? clean(article.lang, 35),
    text,
    words: countWords(text),
    prose: proseShare(text),
  }
}

const PAYWALL =
  /\b(subscribe|subscription|upgrade|sign in|log in|register)\b[^.\n]{0,40}\bto (continue|keep) reading|\b(upgrade|subscribe) (now )?to (read|access|unlock)|\bsubscription (plan )?is required|\b(is|are) (only )?(available|reserved) (to|for) (paid )?(subscribers|members)/i

/**
 * A text that asks the reader to subscribe, when it is short or ends that way, is a paywall teaser
 * (sometimes behind page furniture Readability kept), not the article.
 */
export const paywalled = (article) => (article.words < 400 ? PAYWALL.test(article.text) : PAYWALL.test(article.text.slice(-600)))

/** `text` cut to `max` characters, at a word boundary when one is close. */
export const capText = (text, max) => {
  if (text.length <= max) return { text, truncated: false }
  const cut = text.slice(0, max)
  const space = cut.search(/\s\S*$/)
  return { text: (space > max - 200 ? cut.slice(0, space) : cut).trimEnd(), truncated: true }
}

// ── Fetching ────────────────────────────────────────────────────────────────────────────────────

const decode = (bytes, contentType) => {
  let charset = /charset=["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1]
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096))
    charset = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

const readCapped = async (res, max) => {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  if (size >= max) await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(size, max))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, out.length - at)
    out.set(part, at)
    at += part.length
    if (at >= out.length) break
  }
  return out
}

/**
 * The extractor, with its outside world injected: `fetch` (plain HTTP), `robots` (createRobots)
 * and `render(url, caller)` → { status, url, html }, which throws when the render fails or the
 * render queue is full. Resolves to a result object and never throws.
 */
export const createExtractor = ({ fetch = globalThis.fetch, robots, render, userAgent = USER_AGENT, timeoutMs = FETCH_TIMEOUT_MS }) => {
  const headers = { "user-agent": userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }

  /** Plain fetch with redirects followed by hand, each hop checked. */
  const fetchPlain = async (url, job) => {
    const signal = AbortSignal.timeout(timeoutMs)
    let current = url
    for (let hop = 0; ; hop += 1) {
      let res
      try {
        res = await fetch(current, { headers, redirect: "manual", signal })
      } catch (e) {
        const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError"
        return { reason: timedOut ? `fetch timed out after ${timeoutMs / 1000}s` : `fetch failed: ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 200)}` }
      }
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {})
        const location = res.headers.get("location")
        if (!location) return { reason: `http ${res.status} without a location` }
        if (hop >= MAX_REDIRECTS) return { reason: "too many redirects" }
        const next = new URL(location, current)
        next.hash = ""
        const why = refusal(next.toString(), job.skip_domains)
        if (why) return { skipped: `redirect to ${why}` }
        if (!(await robots.allowed(next.toString()))) return { skipped: `robots.txt disallows ${next.host}${next.pathname}` }
        current = next.toString()
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return { reason: `http ${res.status}`, retry: RENDER_ON_STATUS.has(res.status), final_url: current }
      }
      const type = res.headers.get("content-type") ?? ""
      if (type && !/html|xml|text\/plain/i.test(type)) {
        await res.body?.cancel().catch(() => {})
        return { reason: `not a web page: ${type.split(";")[0].trim()}`, final_url: current }
      }
      try {
        const bytes = await readCapped(res, MAX_FETCH_BYTES)
        return { html: decode(bytes, type), final_url: current }
      } catch (e) {
        return { reason: `fetch failed: ${String(e?.message ?? e).slice(0, 200)}` }
      }
    }
  }

  const ok = (job, final_url, article, rendered) => {
    if (paywalled(article)) return { status: "skipped", reason: "paywall teaser" }
    const { text, truncated } = capText(article.text, job.max_chars)
    const { title, byline, published, lang, words } = article
    return { status: "ok", url: job.url, final_url, title, byline, published, lang, text, words, rendered, truncated }
  }
  const usable = (a) => !!a && a.words >= MIN_WORDS && a.prose >= MIN_PROSE
  const complete = (a) => usable(a) && a.words >= SHORT_WORDS
  const unusable = (...candidates) => {
    const a = candidates.filter(Boolean).sort((x, y) => y.words - x.words)[0]
    return a && a.words >= MIN_WORDS ? `no article text (${Math.round(a.prose * 100)}% prose)` : `too little text (${a?.words ?? 0} words)`
  }

  return async (job, caller) => {
    try {
      const why = refusal(job.url, job.skip_domains)
      if (why) return { status: "skipped", reason: why }
      if (!(await robots.allowed(job.url))) return { status: "skipped", reason: `robots.txt disallows ${new URL(job.url).pathname}` }

      let plain = null
      let article = null
      if (job.render !== "always") {
        plain = await fetchPlain(job.url, job)
        if (plain.skipped) return { status: "skipped", reason: plain.skipped }
        if (plain.html != null) article = extractArticle(plain.html, plain.final_url)
        if (complete(article)) return ok(job, plain.final_url, article, false)
        const worthRendering = plain.html != null || plain.retry
        if (job.render === "never" || !worthRendering) {
          if (usable(article)) return ok(job, plain.final_url, article, false)
          return { status: "failed", reason: plain.reason ?? unusable(article) }
        }
      }

      let page
      try {
        page = await render(job.url, caller)
      } catch (e) {
        if (usable(article)) return ok(job, plain.final_url, article, false)
        return { status: "failed", reason: `render failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}` }
      }
      // Chromium followed any redirects itself: check where it ended up.
      if (page.url !== job.url) {
        const landed = refusal(page.url, job.skip_domains)
        if (landed) return { status: "skipped", reason: `redirect to ${landed}` }
        if (!(await robots.allowed(page.url))) return { status: "skipped", reason: `robots.txt disallows ${new URL(page.url).host}${new URL(page.url).pathname}` }
      }
      if (page.status >= 400) {
        if (usable(article)) return ok(job, plain.final_url, article, false)
        return { status: "failed", reason: `http ${page.status}` }
      }
      const renderedArticle = extractArticle(page.html, page.url)
      // The render wins when it is usable and either longer or the only usable text.
      if (usable(renderedArticle) && (!usable(article) || renderedArticle.words > article.words)) return ok(job, page.url, renderedArticle, true)
      if (usable(article)) return ok(job, plain.final_url, article, false)
      return { status: "failed", reason: unusable(renderedArticle, article) }
    } catch (e) {
      return { status: "failed", reason: `error: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}` }
    }
  }
}
