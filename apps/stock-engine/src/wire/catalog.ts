import type { WireCategory } from "@mb/stock-core/wire"
import { sharedCatalog, unixDate } from "@mb/wire/catalog"
import { blueskySpec } from "@mb/wire/sources/bluesky"
import type { RawItem, SourceSpec } from "./types"
import { ATTENTION_SOURCES } from "./sources/attention"
import { CALENDAR_SOURCES } from "./sources/calendars"
import { CONGRESS_SOURCE } from "./sources/congress"
import { EDGAR_SPECS } from "./sources/edgar"
import { EIA_SOURCE } from "./sources/eia"
import { FDA_SOURCES } from "./sources/fda"
import { haltsSpec } from "./sources/halts"
import { INSIDER_SOURCES } from "./sources/insiders"
import { MARKETBEAT_SOURCES } from "./sources/marketbeat"
import { ODDS_SOURCES } from "./sources/odds"
import { OUTLET_SOURCES } from "./sources/outlets"
import { PDUFA_SOURCE } from "./sources/pdufa"
import { POSITIONING_SOURCES } from "./sources/positioning"
import { USASPENDING_SOURCE } from "./sources/usaspending"
import { VOL_RATES_SOURCES } from "./sources/vol-rates"

/** Social lists approved by the owner (MASTER_PLAN §8.9). All tier 3: they feed the dossier. */
const TELEGRAM_CHANNELS = ["WalterBloomberg", "FinancialJuice", "marketfeed"]
const BLUESKY_ACCOUNTS = ["bloomberg.com", "reuters.com", "apnews.com", "wsj.com", "cnbc.com", "nytimes.com", "axios.com", "politico.com", "marketwatch.com", "barrons.com", "businessinsider.com", "economist.com", "semafor.com"]
/** General outlets post about everything: only market and economy posts go further (the pipeline's relevance filter still applies). */
const BLUESKY_KEYWORDS = /\b(stocks?|shares|markets?|wall street|nasdaq|s&p|dow|fed|federal reserve|rates?|inflation|cpi|jobs report|payrolls|tariffs?|earnings|ipo|merger|acquisition|bankruptcy|sec|treasury|yields?|recession|economy|oil prices)\b|\$[A-Z]{1,5}\b/i
/** Research and narrative newsletters (§8.9, verified from the server 2026-10-26): context for the dossier, polled every 15 min. */
const NEWSLETTERS: [string, string][] = [
  ["liberty_street", "https://libertystreeteconomics.newyorkfed.org/feed/"],
  ["employ_america", "https://www.employamerica.org/rss/"],
  ["abnormal_returns", "https://abnormalreturns.com/feed/"],
  ["noahpinion", "https://www.noahpinion.blog/feed"],
  ["overshoot", "https://theovershoot.co/feed"],
  ["apricitas", "https://www.apricitas.io/feed"],
  ["net_interest", "https://www.netinterest.co/feed"],
  ["doomberg", "https://newsletter.doomberg.com/feed"],
  ["kyla_scanlon", "https://kyla.substack.com/feed"],
]

/**
 * StockMarketBot's news sources (MASTER_PLAN §4.2). Free only; keyed sources stay off until their
 * key is set. Each entry is a generic kind with a URL and an interval; sources that need the
 * Alpaca client or our own market data (alpaca_news, movers, anomaly) are added in main.ts.
 *
 * Verified from the trading server on 2026-10-26 (see the Verified lists in MASTER_PLAN §4.2).
 * GlobeNewswire (403), ACCESSWIRE (404), Newsfile and Business Wire (empty) failed from the server
 * and are left out until they can be reached. Left out of wave 2: MarketScreener (403), the Motley
 * Fool feed (needs a partner key), CNN Business (its RSS stopped in 2018) and CBOE's put/call
 * ratio (no simple endpoint; the Fear & Greed item carries the 5-day average instead). The
 * entries both bots share (government, macro, Truth Social) come from @mb/wire/catalog.
 */

/**
 * Stock files SEC press and litigation releases and DOJ releases as regulatory action, and SEC
 * trading suspensions as halts; the other government feeds are left to the lexicon.
 */
const SHARED = sharedCatalog<WireCategory>({
  "gov:sec_press": "regulatory_action",
  "gov:sec_litigation": "regulatory_action",
  "gov:sec_suspensions": "halt",
  "gov:doj": "regulatory_action",
})

const rss = (id: string, url: string, interval_s: number, tier: SourceSpec["tier"], extra: Partial<SourceSpec> = {}): SourceSpec => ({ id, kind: "rss", url, interval_s, tier, default_enabled: true, ...extra })

type FinnhubNews = { id: number; datetime: number; headline: string; summary: string; url: string; source: string; related?: string }
type MassiveNews = { id: string; title: string; article_url: string; published_utc: string; tickers?: string[]; description?: string; publisher?: { name?: string } }

const day = (d: Date) => d.toISOString().slice(0, 10)

type FedRegDoc = { document_number: string; title: string; type?: string; abstract?: string | null; html_url: string; publication_date: string; agencies?: { name?: string }[] }

/** Federal Register paperwork: information collections, meeting notices, routine exchange rule filings (as in the crypto bot). */
const FEDREG_PAPERWORK = /information collection|paperwork reduction|sunshine act|^self-regulatory organizations;|notice of (meeting|filing)/i
/**
 * Trade-remedy case notices: Commerce publishes dozens a week (antidumping and countervailing duty
 * reviews of one product from one country), and "tariff" finds them all. They don't move the market.
 */
const FEDREG_TRADE_CASES = /\b(antidumping|countervailing|administrative reviews?|sunset reviews?|five-year reviews?|changed circumstances|scope rulings?|less[- ]than[- ]fair[- ]value|circumvention)\b/i
/**
 * Weight by what the document is (as in the crypto bot): a final rule or a presidential document
 * keeps the category base; a proposed rule is context (50, below a review); other notices barely
 * register (35).
 */
const FEDREG_BASE: Record<string, number | undefined> = { Rule: undefined, "Presidential Document": undefined, "Proposed Rule": 50 }

export const fedregItems = (body: unknown): RawItem[] =>
  ((body as { results?: FedRegDoc[] }).results ?? [])
    .filter((d) => !FEDREG_PAPERWORK.test(d.title) && !FEDREG_TRADE_CASES.test(d.title))
    .map((d) => {
      const base = d.type && d.type in FEDREG_BASE ? FEDREG_BASE[d.type] : 35
      return {
        sourceId: d.document_number,
        title: d.title,
        summary: d.abstract ?? null,
        url: d.html_url,
        publishedAt: new Date(`${d.publication_date}T00:00:00Z`),
        ...(base !== undefined ? { baseSeverity: base } : {}),
        meta: { document_type: d.type ?? null, agencies: (d.agencies ?? []).map((a) => a.name).filter(Boolean).join(", ") || null },
      }
    })

const fedreg = (id: string, term: string): SourceSpec => ({
  id,
  kind: "json",
  url: `https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=${encodeURIComponent(term)}&order=newest&per_page=20`,
  interval_s: 600,
  tier: 1,
  category_hint: "policy_shock",
  default_enabled: true,
  note: `Federal Register API (keyless): documents matching ${term}; paperwork and trade-remedy case notices dropped, weighted by document type`,
  map: fedregItems,
})

/** Benzinga's public feed is mostly evergreen explainers ("… Price Prediction 2025–2030"). */
const BENZINGA_EVERGREEN = /price prediction|how to (buy|invest|trade)|\bbest\b.*\bto (buy|watch)\b|\breview\b:|\bvs\.?\b.*\bwhich\b/i
export const benzingaNews = (items: RawItem[]): RawItem[] => items.filter((i) => !BENZINGA_EVERGREEN.test(i.title))

export const CATALOG: SourceSpec[] = [
  // ── Filings and exchange notices (tier 1) ─────────────────────────────────
  ...EDGAR_SPECS,
  haltsSpec,

  // ── Issuers' own releases (tier 1) ────────────────────────────────────────
  rss("pr:prnewswire", "https://www.prnewswire.com/rss/news-releases-list.rss", 45, 1),

  // ── News (tier 2) ─────────────────────────────────────────────────────────
  {
    id: "finnhub",
    kind: "json",
    url: "https://finnhub.io/api/v1/news?category=general",
    interval_s: 60,
    tier: 2,
    key_env: "FINNHUB_API_KEY",
    default_enabled: true,
    headers: (env) => ({ "X-Finnhub-Token": env.FINNHUB_API_KEY ?? "" }),
    map: (body) =>
      (Array.isArray(body) ? (body as FinnhubNews[]) : []).slice(0, 100).map((n) => ({ sourceId: String(n.id), title: n.headline, summary: n.summary, url: n.url, publishedAt: unixDate(n.datetime), meta: { publisher: n.source } })),
  },
  {
    id: "finnhub_merger",
    kind: "json",
    url: "https://finnhub.io/api/v1/news?category=merger",
    interval_s: 120,
    tier: 2,
    key_env: "FINNHUB_API_KEY",
    category_hint: "m_and_a",
    default_enabled: true,
    headers: (env) => ({ "X-Finnhub-Token": env.FINNHUB_API_KEY ?? "" }),
    map: (body) =>
      (Array.isArray(body) ? (body as FinnhubNews[]) : []).slice(0, 100).map((n) => ({ sourceId: String(n.id), title: n.headline, summary: n.summary, url: n.url, publishedAt: unixDate(n.datetime), meta: { publisher: n.source } })),
  },
  {
    id: "finnhub_company",
    kind: "json",
    url: "https://finnhub.io/api/v1/company-news",
    interval_s: 20,
    tier: 2,
    key_env: "FINNHUB_API_KEY",
    symbols: "held+focus",
    default_enabled: true,
    headers: (env) => ({ "X-Finnhub-Token": env.FINNHUB_API_KEY ?? "" }),
    urlFor: (symbol) => {
      const now = new Date()
      return `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(new Date(now.getTime() - 86_400_000))}&to=${day(now)}`
    },
    map: (body) =>
      (Array.isArray(body) ? (body as FinnhubNews[]) : []).slice(0, 30).map((n) => ({
        sourceId: String(n.id),
        title: n.headline,
        summary: n.summary,
        url: n.url,
        publishedAt: unixDate(n.datetime),
        symbols: (n.related ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 4),
        meta: { publisher: n.source },
      })),
  },
  {
    id: "massive_news",
    kind: "json",
    url: "https://api.massive.com/v2/reference/news?limit=50&order=desc&sort=published_utc",
    interval_s: 75,
    tier: 2,
    key_env: "MASSIVE_API_KEY",
    default_enabled: true,
    headers: (env) => ({ Authorization: `Bearer ${env.MASSIVE_API_KEY ?? ""}` }),
    note: "Massive (formerly Polygon.io) free plan: 5 calls/min",
    map: (body) =>
      ((body as { results?: MassiveNews[] }).results ?? []).map((n) => ({
        sourceId: n.id,
        title: n.title,
        summary: n.description ?? null,
        url: n.article_url,
        publishedAt: new Date(n.published_utc),
        symbols: (n.tickers ?? []).map((s) => s.toUpperCase()).slice(0, 6),
        meta: { publisher: n.publisher?.name ?? null },
      })),
  },

  // ── Government, regulators and policy (tier 1) ───────────────────────────
  SHARED["gov:sec_press"],
  SHARED["gov:sec_litigation"],
  SHARED["gov:sec_suspensions"],
  rss("gov:ftc", "https://www.ftc.gov/feeds/press-release.xml", 300, 1, { category_hint: "antitrust" }),
  SHARED["gov:doj"],
  SHARED["gov:whitehouse"],
  rss("gov:ustr", "https://ustr.gov/rss.xml", 300, 1),
  rss("gov:bis", "https://www.bis.doc.gov/index.php/news-updates?format=feed&type=rss", 300, 1),
  SHARED["gov:ofac"],
  SHARED["gov:fed"],
  rss("gov:fed_speeches", "https://www.federalreserve.gov/feeds/speeches.xml", 600, 1),
  rss("gov:fda", "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml", 300, 1, { category_hint: "fda" }),

  // ── Per-symbol coverage for what we hold and watch ────────────────────────
  rss("persymbol:gnews", "https://news.google.com/rss", 20, 3, {
    symbols: "held+focus",
    urlFor: (symbol) => `https://news.google.com/rss/search?q=${encodeURIComponent(`"${symbol}" stock`)}+when:1h&hl=en-US&gl=US&ceid=US:en`,
  }),
  rss("persymbol:yahoo", "https://feeds.finance.yahoo.com/rss/2.0/headline", 20, 2, {
    symbols: "held+focus",
    urlFor: (symbol) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
  }),

  // ── Social (tier 3, owner-approved lists) ─────────────────────────────────
  ...TELEGRAM_CHANNELS.map((channel): SourceSpec => ({ id: `telegram:${channel}`, kind: "telegram", channel, interval_s: 30, tier: 3, default_enabled: true })),
  blueskySpec({ accounts: BLUESKY_ACCOUNTS, keywords: BLUESKY_KEYWORDS }),
  ...NEWSLETTERS.map(([name, url]) => rss(`newsletter:${name}`, url, 900, 3)),

  // ── Primary statements and calendars ─────────────────────────────────────
  SHARED.truth_social,
  SHARED.macro_ff,

  // ════ Wave 2 (MASTER_PLAN §4.2; verified from the server 2026-10-26) ═══════

  // ── Outlets: major newsrooms tier 2, aggregators and explainers tier 3 ──────
  // The relevance filter keeps only items that name a tracked ticker or the whole market.
  rss("rss:cnbc", "https://www.cnbc.com/id/100003114/device/rss/rss.html", 60, 2),
  rss("rss:marketwatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories", 60, 2),
  rss("rss:wsj_markets", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", 90, 2),
  rss("rss:foxbusiness", "https://moxie.foxbusiness.com/google-publisher/markets.xml", 120, 2),
  rss("rss:nyt_business", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", 180, 2),
  rss("rss:ft_markets", "https://www.ft.com/markets?format=rss", 180, 2),
  rss("rss:politico", "https://rss.politico.com/economy.xml", 300, 2),
  rss("rss:economist", "https://www.economist.com/finance-and-economics/rss.xml", 900, 2),
  rss("rss:investing", "https://www.investing.com/rss/news.rss", 90, 3),
  rss("rss:rttnews", "https://www.rttnews.com/RSS/BreakingNews.xml", 120, 3),
  rss("rss:benzinga", "https://www.benzinga.com/feed", 300, 3, { refine: benzingaNews, note: "Benzinga's public feed; evergreen explainers dropped" }),
  ...OUTLET_SOURCES,

  // ── Central banks, rules and macro numbers (tier 1) ──────────────────────
  SHARED["cb:ecb"],
  SHARED["cb:boe"],
  SHARED["cb:boj"],
  fedreg("fedreg:tariff", "tariff"),
  fedreg("fedreg:export", '"entity list"'),
  SHARED.macro_actuals,
  EIA_SOURCE,
  ...VOL_RATES_SOURCES,
  ...ODDS_SOURCES,

  // ── Company catalysts ─────────────────────────────────────────────────────
  ...FDA_SOURCES,
  ...CALENDAR_SOURCES,
  ...INSIDER_SOURCES,
  USASPENDING_SOURCE,

  // ── Positioning and attention ─────────────────────────────────────────────
  ...POSITIONING_SOURCES,
  ...ATTENTION_SOURCES,

  // ════ Wave 3 (MASTER_PLAN §4.2; terms and robots.txt checked in Phase 7.4) ═══
  // Plain HTML: none of the allowed sites needs the scraper sidecar yet.
  ...MARKETBEAT_SOURCES,
  PDUFA_SOURCE,
  CONGRESS_SOURCE,
]
