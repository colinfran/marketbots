import { load } from "cheerio"
import type { PollFn } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"

/**
 * A public Telegram channel through its web preview (`t.me/s/<channel>`): no login, no API key.
 * The preview shows the latest ~20 posts; each post's `data-post` id is its identity.
 */

export const parseTelegram = (html: string, channel: string): RawItem<never>[] => {
  const $ = load(html)
  const items: RawItem<never>[] = []
  $(".tgme_widget_message[data-post]").each((_, el) => {
    const node = $(el)
    const post = node.attr("data-post") ?? ""
    const textNode = node.find(".tgme_widget_message_text").first()
    // Line breaks become spaces so the first line doesn't run into the next.
    textNode.find("br").replaceWith(" ")
    const body = textNode.text().replace(/\s+/g, " ").trim()
    if (!post || !body) return
    const time = node.find("time[datetime]").first().attr("datetime")
    const published = time ? new Date(time) : null
    items.push({
      sourceId: post,
      title: body.length > 280 ? `${body.slice(0, 279)}…` : body,
      summary: body.length > 280 ? body : null,
      url: `https://t.me/${post}`,
      publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
      meta: { channel },
    })
  })
  return items
}

export const telegramPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  if (!spec.channel) throw new Error(`${spec.id}: a telegram source needs a channel`)
  return async () => {
    const res = await ctx.fetch.get(`https://t.me/s/${spec.channel}`, { headers: { accept: "text/html" } })
    if (res.notModified) return null
    const items = parseTelegram(res.text, spec.channel!)
    return spec.refine ? spec.refine(items, ctx) : items
  }
}
