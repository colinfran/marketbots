import type { RawItem, SourceSpec } from "./types"
import { ATTENTION_SOURCES } from "./sources/attention"
import { blueskySpec } from "./sources/bluesky"
import { CALENDAR_SOURCES } from "./sources/calendars"
import { CONGRESS_SOURCE } from "./sources/congress"
import { EDGAR_SPECS } from "./sources/edgar"
import { EIA_SOURCE } from "./sources/eia"
import { FDA_SOURCES } from "./sources/fda"
import { haltsSpec } from "./sources/halts"
import { INSIDER_SOURCES } from "./sources/insiders"
import { MACRO_ACTUALS } from "./sources/macro-actuals"
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
 * ratio (no simple endpoint; the Fear & Greed item carries the 5-day average instead).
 */

const unixDate = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

const rss = (id: string, url: string, interval_s: number, tier: SourceSpec["tier"], extra: Partial<SourceSpec> = {}): SourceSpec => ({ id, kind: "rss", url, interval_s, tier, default_enabled: true, ...extra })

type FinnhubNews = { id: number; datetime: number; headline: string; summary: string; url: string; source: string; related?: string }
type DojRelease = { uuid: string; title: string; url: string; date: string; teaser?: string }
type FfEvent = { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string }
type MassiveNews = { id: string; title: string; article_url: string; published_utc: string; tickers?: string[]; description?: string; publisher?: { name?: string } }

const day = (d: Date) => d.toISOString().slice(0, 10)

/** Rate decisions and the policy statements around them; the feeds' statistics and speeches stay out. */
const CB_DECISION = /monetary policy (decisions?|statement|summary|report)|statement on monetary policy|key ecb interest rates|\bbank rate\b|guideline for (money )?market operations|outlook for economic activity and prices/i

/** ECB, BoE and BoJ feeds (mirrored with the crypto bot): decisions only, market-wide. */
export const centralBankDecisions = (items: RawItem[]): RawItem[] =>
  items.filter((i) => CB_DECISION.test(i.title)).map((i) => ({ ...i, symbols: [], marketWide: true, category: "macro_release" as const, kind: "macro" as const }))

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
  rss("gov:sec_press", "https://www.sec.gov/news/pressreleases.rss", 120, 1, { category_hint: "regulatory_action", key_env: "SEC_USER_AGENT" }),
  rss("gov:sec_litigation", "https://www.sec.gov/enforcement-litigation/litigation-releases/rss", 300, 1, { category_hint: "regulatory_action", key_env: "SEC_USER_AGENT" }),
  rss("gov:sec_suspensions", "https://www.sec.gov/enforcement-litigation/trading-suspensions/rss", 300, 1, { category_hint: "halt", key_env: "SEC_USER_AGENT" }),
  rss("gov:ftc", "https://www.ftc.gov/feeds/press-release.xml", 300, 1, { category_hint: "antitrust" }),
  {
    id: "gov:doj",
    kind: "json",
    url: "https://www.justice.gov/api/v1/press_releases.json?pagesize=25&sort=date&direction=DESC",
    interval_s: 300,
    tier: 1,
    category_hint: "regulatory_action",
    default_enabled: true,
    map: (body) => ((body as { results?: DojRelease[] }).results ?? []).map((r) => ({ sourceId: r.uuid, title: r.title, summary: r.teaser ?? null, url: r.url, publishedAt: unixDate(r.date) })),
  },
  rss("gov:whitehouse", "https://www.whitehouse.gov/presidential-actions/feed/", 300, 1),
  rss("gov:ustr", "https://ustr.gov/rss.xml", 300, 1),
  rss("gov:bis", "https://www.bis.doc.gov/index.php/news-updates?format=feed&type=rss", 300, 1),
  rss("gov:ofac", "https://ofac.treasury.gov/rss.xml", 300, 1),
  rss("gov:fed", "https://www.federalreserve.gov/feeds/press_all.xml", 120, 1),
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
  rss("truth_social", "https://www.trumpstruth.org/feed", 60, 1, { note: "trumpstruth.org mirror of Truth Social; the posts are primary statements" }),
  {
    id: "macro_ff",
    kind: "json",
    url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    interval_s: 300,
    tier: 3,
    wire_kind: "calendar",
    category_hint: "macro_release",
    default_enabled: true,
    note: "ForexFactory weekly calendar (unofficial): times and forecasts for high-impact USD events",
    map: (body) =>
      (Array.isArray(body) ? (body as FfEvent[]) : [])
        .filter((e) => e.country === "USD" && e.impact === "High")
        .map(
          (e): RawItem => ({
            sourceId: `${e.title}|${e.date}`,
            title: `Scheduled: ${e.title} at ${e.date}${e.forecast ? ` (forecast ${e.forecast}, previous ${e.previous || "n/a"})` : ""}`,
            url: "https://www.forexfactory.com/calendar",
            publishedAt: null,
            category: "macro_release",
            kind: "calendar",
            marketWide: true,
            baseSeverity: 15,
            meta: { event_at: new Date(e.date).toISOString(), forecast: e.forecast || null, previous: e.previous || null },
          }),
        ),
  },

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
  rss("cb:ecb", "https://www.ecb.europa.eu/rss/press.html", 300, 1, { wire_kind: "macro", category_hint: "macro_release", refine: centralBankDecisions }),
  rss("cb:boe", "https://www.bankofengland.co.uk/rss/news", 300, 1, { wire_kind: "macro", category_hint: "macro_release", refine: centralBankDecisions }),
  rss("cb:boj", "https://www.boj.or.jp/en/rss/whatsnew.xml", 300, 1, { wire_kind: "macro", category_hint: "macro_release", refine: centralBankDecisions }),
  fedreg("fedreg:tariff", "tariff"),
  fedreg("fedreg:export", '"entity list"'),
  MACRO_ACTUALS,
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
