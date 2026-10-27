// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { createHash } from "node:crypto"
import { cleanLine, cleanUrl, domainOf } from "../util/text"
import type { RawItem } from "./types"

/**
 * Turns a RawItem into safe, comparable fields: HTML stripped, entities decoded, invisible
 * characters removed, lengths capped, URLs reduced to a canonical form (no tracking parameters
 * or fragments), and a dedupe id that is stable across restarts.
 */

export const TITLE_MAX = 300
export const SUMMARY_MAX = 1_000

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", trade: "™", reg: "®", copy: "©" }

export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""
    }
    return NAMED[e.toLowerCase()] ?? m
  })

/** Plain text from an HTML fragment (scripts and styles dropped entirely). */
export const stripHtml = (s: string) =>
  decodeEntities(
    s
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|cmpid|ocid|ref|ref_src|src|smid|guccounter|taid|mod)$/i

/** The URL with tracking parameters, fragments and trailing slashes removed, or null. */
export const canonicalUrl = (value: unknown): string | null => {
  const clean = cleanUrl(value)
  if (!clean) return null
  const url = new URL(clean)
  url.hash = ""
  url.hostname = url.hostname.toLowerCase()
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
  return url.toString()
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32)

/** The item's identity: the source plus its own id, else its canonical URL, else its title. */
export const itemId = (source: string, raw: Pick<RawItem, "sourceId" | "title">, url: string | null) =>
  sha(`${source}|${raw.sourceId ? `id:${raw.sourceId}` : url ? `url:${url}` : `title:${raw.title.toLowerCase()}`}`)

export type NormalizedFields = { id: string; title: string; summary: string | null; url: string | null; domain: string | null; published_at: Date }

export const normalizeRaw = (source: string, raw: RawItem, now: Date): NormalizedFields | null => {
  const title = cleanLine(stripHtml(raw.title ?? ""), TITLE_MAX)
  if (!title) return null
  const summaryText = raw.summary ? cleanLine(stripHtml(raw.summary), SUMMARY_MAX) : ""
  const url = canonicalUrl(raw.url)
  const published = raw.publishedAt && Number.isFinite(raw.publishedAt.getTime()) ? raw.publishedAt : now
  return {
    id: itemId(source, { ...raw, title }, url),
    title,
    // A summary that only repeats the title adds nothing.
    summary: summaryText && summaryText !== title ? summaryText : null,
    url,
    domain: url ? domainOf(url) || null : null,
    // Sources sometimes claim the future; nothing is published after we saw it.
    published_at: published.getTime() > now.getTime() ? now : published,
  }
}
