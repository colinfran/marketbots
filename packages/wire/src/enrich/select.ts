import type { WireSummariesSettings } from "@mb/core/settings"
import type { WireItemDoc } from "@mb/core/wire"

/**
 * Which items get an article summary: the
 * first item of its cluster, at or above the summaries' minimum severity or notable, with a link to
 * a real article in English on a domain we may fetch. Many qualifying items aren't articles at all
 * (trading halts, social posts, odds markets, filing indexes, videos), so only news and central-bank
 * releases count, and links to known non-article pages are refused before the scraper is asked.
 */

/** The paywalled sites the scraper refuses on its own (apps/scraper/extract.mjs DEFAULT_SKIP_DOMAINS). */
export const PAYWALL_DOMAINS = ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "seekingalpha.com"] as const

/** Item kinds that link to articles: news, and central banks' own releases. Filings, venue notices (halts), odds and data are not. */
const ARTICLE_KINDS = new Set(["news", "macro"])

/** Hosts (with their subdomains) whose pages are not articles we summarize, and why. */
const NOT_ARTICLES: [string, string][] = [
  ["news.google.com", "Google News redirect"],
  ["x.com", "social post"],
  ["twitter.com", "social post"],
  ["truthsocial.com", "social post"],
  ["trumpstruth.org", "social post"],
  ["bsky.app", "social post"],
  ["t.me", "social post"],
  ["telegram.me", "social post"],
  ["kalshi.com", "odds market"],
  ["polymarket.com", "odds market"],
  ["nasdaqtrader.com", "trading halt"],
  ["accessdata.fda.gov", "FDA database page"],
  ["api.fda.gov", "FDA database page"],
  ["clinicaltrials.gov", "trial registry page"],
  ["youtube.com", "video"],
  ["youtu.be", "video"],
  // Benzinga's content may only be shown as headline, source and link (@mb/web-kit/queries).
  ["benzinga.com", "Benzinga (headline and link only)"],
]

const EDGAR_PATH = /^\/(cgi-bin\/browse-edgar|archives\/edgar)\b/i
const VIDEO_PATH = /\/videos?\//i
const FILE_PATH = /\.(pdf|xml|json|zip|mp4|mp3)$/i

const covers = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** The domain in `list` that covers `host` (itself or a parent domain), else null. */
export const skippedDomain = (host: string, list: readonly string[]) => list.find((d) => covers(host, d)) ?? null

/** A title in a non-Latin script is not an English article (a Latin-script language is caught after extraction). */
const latinTitle = (title: string) => {
  const letters = title.match(/\p{L}/gu) ?? []
  if (letters.length < 8) return true
  return letters.filter((c) => /[a-z]/i.test(c)).length / letters.length >= 0.8
}

export type SummaryCandidate = Pick<WireItemDoc<string>, "_id" | "cluster_id" | "kind" | "title" | "url" | "severity" | "notable"> & { article?: unknown }

/** Why an item gets no summary, or null when it qualifies. */
export const skipReason = (item: SummaryCandidate, s: Pick<WireSummariesSettings, "min_severity" | "skip_domains">): string | null => {
  if (item.article) return "already summarized"
  if (item.cluster_id !== item._id) return "not the first item of its cluster"
  if (item.severity < s.min_severity && !item.notable) return `severity ${item.severity} below ${s.min_severity}`
  if (!ARTICLE_KINDS.has(item.kind)) return `${item.kind} item`
  if (!item.url) return "no article link"
  let url: URL
  try {
    url = new URL(item.url)
  } catch {
    return "no article link"
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "no article link"
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  for (const [domain, why] of NOT_ARTICLES) if (covers(host, domain)) return why
  if (covers(host, "sec.gov") && EDGAR_PATH.test(url.pathname)) return "EDGAR filing page"
  if (VIDEO_PATH.test(url.pathname)) return "video"
  if (FILE_PATH.test(url.pathname)) return "not a web page"
  const skipped = skippedDomain(host, [...PAYWALL_DOMAINS, ...s.skip_domains])
  if (skipped) return `skip list: ${skipped}`
  if (!latinTitle(item.title)) return "not English"
  return null
}

/** Common English function words: in English prose they are well over a tenth of all words; in other languages almost none. */
const ENGLISH = new Set(
  "the of and to is that for with was by it from are this has have said its will which were been their be at as an on in not or but would could".split(" "),
)

/** Whether extracted article text reads as English: its declared language, if any, and its words. */
export const isEnglish = (text: string, lang: string | null | undefined) => {
  if (lang && !/^en\b/i.test(lang.trim())) return false
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? []
  if (words.length < 30) return true
  return words.filter((w) => ENGLISH.has(w)).length / words.length >= 0.08
}
