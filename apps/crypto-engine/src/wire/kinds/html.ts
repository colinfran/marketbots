// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { load } from "cheerio"
import type { PollFn } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"

/**
 * An HTML page turned into items with cheerio selectors (or a custom mapper). Only for pages
 * whose robots.txt and terms allow it; the catalog notes the check.
 */

const MAX_ITEMS = 60

export const parseHtml = (html: string, selectors: NonNullable<SourceSpec["selectors"]>, baseUrl: string): RawItem[] => {
  const $ = load(html)
  const items: RawItem[] = []
  $(selectors.item)
    .slice(0, MAX_ITEMS)
    .each((_, el) => {
      const node = $(el)
      const title = node.find(selectors.title).first().text().trim() || (selectors.title === "self" ? node.text().trim() : "")
      const href = selectors.link ? (node.find(selectors.link).first().attr("href") ?? node.attr("href")) : node.find("a").first().attr("href")
      const time = selectors.time ? (node.find(selectors.time).first().attr("datetime") ?? node.find(selectors.time).first().text()) : null
      let url: string | null = null
      try {
        url = href ? new URL(href, baseUrl).toString() : null
      } catch {
        url = null
      }
      const published = time ? new Date(time) : null
      items.push({
        title,
        url,
        summary: selectors.summary ? node.find(selectors.summary).first().text().trim() || null : null,
        publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
      })
    })
  return items.filter((i) => i.title)
}

export const htmlPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  if (!spec.selectors && !spec.mapHtml) throw new Error(`${spec.id}: an html source needs selectors or mapHtml`)
  return async () => {
    const res = await ctx.fetch.get(spec.url!, { headers: { accept: "text/html", ...spec.headers?.(ctx.env) } })
    if (res.notModified) return null
    return spec.mapHtml ? spec.mapHtml(res.text, ctx) : parseHtml(res.text, spec.selectors!, spec.url!)
  }
}
