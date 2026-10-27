// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { XMLParser } from "fast-xml-parser"
import type { PollFn } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"

/**
 * RSS 2.0, RDF (RSS 1.0) and Atom feeds. Conditional GET makes an unchanged feed nearly free.
 * Per-symbol feeds (`urlFor`) poll one symbol per tick, round-robin through the chosen set.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
})

const MAX_ITEMS = 100

type Node = string | number | { "#text"?: string | number; "@_href"?: string; "@_rel"?: string } | undefined

const text = (v: unknown): string => {
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  if (Array.isArray(v)) return text(v[0])
  if (v && typeof v === "object" && "#text" in v) return text((v as { "#text": unknown })["#text"])
  return ""
}

const date = (v: unknown): Date | null => {
  const s = text(v).trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

const rssLink = (v: unknown): string => {
  const links = (Array.isArray(v) ? v : [v]) as Node[]
  for (const l of links) {
    if (typeof l === "string" && l.trim()) return l.trim()
    if (l && typeof l === "object" && l["@_href"]) return l["@_href"]
    const t = text(l).trim()
    if (t) return t
  }
  return ""
}

const atomLink = (v: unknown): string => {
  const links = (Array.isArray(v) ? v : [v]) as Node[]
  const objs = links.filter((l): l is Exclude<Node, string | number | undefined> => !!l && typeof l === "object")
  return (objs.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? objs[0])?.["@_href"] ?? rssLink(v)
}

export const parseFeed = (xml: string): RawItem[] => {
  const doc = parser.parse(xml) as Record<string, Record<string, unknown> | undefined>
  const rss = ((doc.rss?.channel as Record<string, unknown> | undefined)?.item ?? doc["rdf:RDF"]?.item ?? []) as Record<string, unknown>[]
  const atom = (doc.feed?.entry ?? []) as Record<string, unknown>[]
  const items: RawItem[] = []
  for (const i of rss.slice(0, MAX_ITEMS)) {
    items.push({
      sourceId: text(i.guid).trim() || null,
      title: text(i.title),
      summary: text(i.description) || text(i["content:encoded"]) || null,
      url: rssLink(i.link) || null,
      publishedAt: date(i.pubDate) ?? date(i["dc:date"]) ?? date(i.published) ?? date(i.updated),
    })
  }
  for (const e of atom.slice(0, MAX_ITEMS)) {
    items.push({
      sourceId: text(e.id).trim() || null,
      title: text(e.title),
      summary: text(e.summary) || text(e.content) || null,
      url: atomLink(e.link) || null,
      publishedAt: date(e.published) ?? date(e.updated),
    })
  }
  return items.filter((i) => i.title.trim())
}

/** Round-robin over the symbols a per-symbol feed covers. */
export const symbolCycler = (spec: SourceSpec, ctx: SourceContext) => {
  let i = 0
  return (): string | null => {
    const s = ctx.symbols()
    const list = spec.symbols === "held+focus" ? [...new Set([...s.held, ...s.focus])] : s.universe
    if (!list.length) return null
    return list[i++ % list.length]
  }
}

export const rssPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  const next = spec.urlFor ? symbolCycler(spec, ctx) : null
  return async () => {
    const symbol = next ? next() : null
    if (next && !symbol) return []
    const url = symbol && spec.urlFor ? spec.urlFor(symbol) : spec.url!
    const res = await ctx.fetch.get(url, { headers: spec.headers?.(ctx.env) })
    if (res.notModified) return null
    const parsed = parseFeed(res.text)
    const items = symbol ? parsed.map((i) => ({ ...i, meta: { ...i.meta, query_symbol: symbol } })) : parsed
    return spec.refine ? spec.refine(items, ctx) : items
  }
}
