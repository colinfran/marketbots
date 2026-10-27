import { load } from "cheerio"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { baseOf } from "./common"
import { largestAmountUsd } from "../lexicon"

/**
 * SlowMist Hacked (MASTER_PLAN §4.1 wave 3, `hacks`), tier 2: the hack database's front page, one
 * row per incident with the date, target, description, loss and attack method (plain HTML; no
 * robots.txt or terms restrict it, Phase 7.4). SlowMist logs incidents hours to days after the
 * first reports, so these items are dossier context: dated by day, they never pass the trigger
 * gates' old-news check. The outlets and Telegram report the big ones first.
 *
 * Descriptions name the chain a protocol runs on ("an Ethereum DeFi protocol"), which says
 * nothing about ETH itself, so the adapter sets the symbols: a universe asset only when it is the
 * hacked target, and market-wide only from MARKET_WIDE_USD lost. Smaller hacks of other
 * protocols name nothing we track and are dropped.
 */

const MARKET_WIDE_USD = 10e6

/** Universe assets by the names a hack target would go by ("Solana", "Ethereum Foundation"…). */
const ASSET_NAMES: Record<string, RegExp> = {
  BTC: /^bitcoin\b/i,
  ETH: /^(ethereum|ether)\b/i,
  SOL: /^solana\b/i,
  XRP: /^(xrp|ripple)\b/i,
  DOGE: /^dogecoin\b/i,
  ADA: /^cardano\b/i,
  LINK: /^chainlink\b/i,
  AVAX: /^avalanche\b/i,
  LTC: /^litecoin\b/i,
  DOT: /^polkadot\b/i,
}

const text = (s: string) => s.replace(/\s+/g, " ").trim()

export const slowmistItems = (html: string, ctx: Pick<SourceContext, "symbols">): RawItem[] => {
  const $ = load(html)
  const universe = ctx.symbols().universe
  return $(".case-content li")
    .toArray()
    .flatMap((el): RawItem[] => {
      const row = $(el)
      const day = text(row.find("span.time").first().text())
      const heading = row.find("h3").first().clone()
      heading.find("em").remove()
      const target = text(heading.text())
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !target) return []
      const field = (label: string) => {
        const node = row.find("em").filter((_, e) => $(e).text().startsWith(label)).first().parent().clone()
        node.find("em").remove()
        return text(node.text())
      }
      const description = field("Description of the event")
      const loss = field("Amount of loss").replace(/^\$\s+/, "$")
      const method = field("Attack method")
      const amount = largestAmountUsd(loss.replace(/\s/g, ""))
      const symbols = universe.filter((s) => ASSET_NAMES[baseOf(s)]?.test(target))
      const marketWide = !symbols.length && amount !== null && amount >= MARKET_WIDE_USD
      if (!symbols.length && !marketWide) return []
      return [
        {
          sourceId: `${day}|${target}`,
          title: `${target} hacked${loss ? `: ${loss} lost` : ""}${method ? ` (${method})` : ""}`,
          summary: description || null,
          url: row.find("p.link-reference a").attr("href") ?? "https://hacked.slowmist.io/",
          publishedAt: new Date(`${day}T00:00:00Z`),
          symbols,
          marketWide,
          category: "exploit",
          polarity: -1,
          meta: { target, loss_usd: amount, attack_method: method || null, reported_by: "slowmist" },
        },
      ]
    })
}

export const HACKS_SOURCE: SourceSpec = {
  id: "hacks:slowmist",
  kind: "html",
  url: "https://hacked.slowmist.io/",
  interval_s: 900,
  tier: 2,
  wire_kind: "news",
  default_enabled: true,
  note: "SlowMist Hacked database (plain HTML): incidents naming a universe asset, or $10M+ lost (market-wide)",
  mapHtml: slowmistItems,
}
