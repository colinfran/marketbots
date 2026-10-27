import type { WireCategory } from "@mb/crypto-core/wire"
import { sharedCatalog, unixDate } from "@mb/wire/catalog"
import { blueskySpec } from "@mb/wire/sources/bluesky"
import { ATTENTION_SOURCES } from "./sources/attention"
import { CHAIN_SOURCES } from "./sources/chain"
import { universeBases } from "./sources/common"
import { DEFILLAMA_SOURCES } from "./sources/defillama"
import { DERIVATIVES_SOURCES } from "./sources/derivatives"
import { HACKS_SOURCE } from "./sources/hacks"
import { KOREA_SOURCES } from "./sources/korea"
import { ODDS_SOURCES } from "./sources/odds"
import type { RawItem, SourceContext, SourceSpec } from "./types"

/**
 * CryptoMarketBot's news sources. Free only; keyed sources stay off until
 * their key is set. Each entry is a generic kind with a URL and an interval; the few that need
 * more (streams, numeric watchers, our own anomaly detectors) live in sources/ and in the market hub.
 * The entries both bots share (government, macro, Truth Social) come from @mb/wire/catalog.
 *
 * Wave 1 verified from the trading server on 2026-10-26, wave 2 on 2026-10-27. Left out of wave 2:
 * the Coinbase blog (Cloudflare 403 from the server), Gemini's blog (no feed) and Robinhood's
 * newsroom feed (404).
 */

/** Crypto files the US government feeds as regulatory action, and the Fed's as macro. */
const SHARED = sharedCatalog<WireCategory>({
  "gov:sec_press": "regulatory_action",
  "gov:sec_litigation": "regulatory_action",
  "gov:sec_suspensions": "regulatory_action",
  "gov:doj": "regulatory_action",
  "gov:ofac": "regulatory_action",
  "gov:fed": "macro_release",
  "gov:whitehouse": "regulatory_action",
})

/** What to search Google News for, per base asset (bare tickers like SOL or LINK are too ambiguous). */
const SEARCH_NAMES: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana crypto",
  XRP: "XRP ripple",
  DOGE: "dogecoin",
  ADA: "cardano crypto",
  LINK: "chainlink crypto",
  AVAX: "avalanche avax",
  LTC: "litecoin",
  DOT: "polkadot crypto",
}

const rss = (id: string, url: string, interval_s: number, tier: SourceSpec["tier"], extra: Partial<SourceSpec> = {}): SourceSpec => ({ id, kind: "rss", url, interval_s, tier, default_enabled: true, ...extra })

type FinnhubNews = { id: number; datetime: number; headline: string; summary: string; url: string; source: string; related?: string }
type KrakenPairs = { error: string[]; result: Record<string, { wsname?: string; altname: string; quote: string; status?: string }> }

/** Kraken's websocket names use XBT and XDG; the bot uses BTC and DOGE. */
const krakenSymbol = (wsname: string) => wsname.replace(/^XBT\//, "BTC/").replace(/^XDG\//, "DOGE/")

type CoinbaseProduct = { id: string; base_currency: string; quote_currency: string; status: string; trading_disabled?: boolean }
type FedRegDoc = { document_number: string; title: string; type?: string; abstract?: string | null; html_url: string; publication_date: string; agencies?: { name?: string }[] }
type GdeltArticle = { url: string; title: string; seendate?: string; domain?: string; language?: string; sourcecountry?: string }
type CotRow = Record<string, string>

/** Client releases are only news when they are final: no release candidates, betas or test builds. */
const PRERELEASE = /(rc|alpha|beta)\.?\d*\b|release candidate|-b\d|\b(custom|docker|snapshot|audit|nightly|preview)\b/i

/**
 * A GitHub releases feed: final releases only, tagged to the chain's asset. A new version line
 * (32.0, 1.17.0) gets the upgrade base (30); point releases (32.1, 3.4.1) stay below it (20), and
 * neither can reach a review even for a held position: client releases are context, not events.
 */
export const githubReleases =
  (base: string, label: string) =>
  (items: RawItem[], ctx: SourceContext): RawItem[] => {
    const symbol = universeBases(ctx).get(base)
    if (!symbol) return []
    return items
      .filter((i) => !PRERELEASE.test(i.title))
      .map((i) => {
        const v = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(i.title)
        // The last part of the version is zero: a new line, not a point release.
        const line = !!v && (v[3] ?? v[2]) === "0"
        return {
          ...i,
          title: i.title.toLowerCase().includes(label.toLowerCase()) ? i.title : `${label} release ${i.title}`,
          // Release notes are long and full of words the lexicon would misread.
          summary: null,
          symbols: [symbol],
          category: "upgrade" as const,
          polarity: 0 as const,
          baseSeverity: line ? 30 : 20,
          meta: { ...i.meta, release: true, new_line: line },
        }
      })
  }

const BINANCE_LISTING = /^binance will list\b/i
/**
 * Promotions, campaigns, product notices and Binance-only plumbing (wallet maintenance, deposit
 * suspensions for a network upgrade): nothing about the coins themselves, and never a reason to
 * alert about a venue we don't trade on.
 */
const BINANCE_NOISE = /trading competition|suspen\w* (of )?(deposits|withdrawals)|(deposits|withdrawals)( and (deposits|withdrawals))? (will be )?suspended|tournament|carnival|prize pool|\brewards?\b|airdrop|giveaway|yield arena|\bearn\b|launchpool|megadrop|binance alpha|bstocks?|tokenized securities|wallet maintenance|tick size|collateral|margin|copy trading|\bvip\b|referral|dividend/i

/**
 * Binance's announcements channel: "Binance Will List …" posts are listings; promotions and
 * plumbing are dropped; everything else goes to the lexicon. Nothing here is market-wide, so only
 * posts that name a universe asset are kept (Binance lists and delists small tokens every week).
 */
export const binanceAnnouncements = (items: RawItem[]): RawItem[] =>
  items.flatMap((i) => (BINANCE_LISTING.test(i.title) ? [{ ...i, category: "listing_major" as const, polarity: 1 as const, marketWide: false }] : BINANCE_NOISE.test(i.title) ? [] : [{ ...i, marketWide: false }]))

/** Federal Register paperwork: information collections, meeting notices, routine exchange rule filings. */
const FEDREG_PAPERWORK = /information collection|paperwork reduction|sunshine act|^self-regulatory organizations;|notice of (meeting|filing)/i
/**
 * Weight by what the document is: a final rule or a presidential document keeps the regulatory
 * base (70); a proposed rule is context (50, below a review); other notices barely register (35).
 */
const FEDREG_BASE: Record<string, number | undefined> = { Rule: undefined, "Presidential Document": undefined, "Proposed Rule": 50 }

const fedreg = (id: string, term: string): SourceSpec => ({
  id,
  kind: "json",
  url: `https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=${encodeURIComponent(term)}&order=newest&per_page=20`,
  interval_s: 600,
  tier: 1,
  category_hint: "regulatory_action",
  default_enabled: true,
  note: `Federal Register API (keyless): documents matching ${term}; paperwork notices dropped, the lexicon keeps those whose title is about crypto`,
  map: (body) =>
    ((body as { results?: FedRegDoc[] }).results ?? [])
      .filter((d) => !FEDREG_PAPERWORK.test(d.title))
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
      }),
})

/** GDELT's "20261027T023000Z". */
const gdeltDate = (s: string | undefined) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? "")
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null
}

/** One OR query for the universe (avalanche and ripple mean other things too: AVAX and XRP instead). */
const GDELT_QUERY = "(bitcoin OR ethereum OR solana OR xrp OR dogecoin OR cardano OR chainlink OR avax OR litecoin OR polkadot) sourcelang:english"

/** CME bitcoin and ether futures (not the micro contracts): the rows of one weekly report. */
const COT_MARKETS: [RegExp, string][] = [
  [/^BITCOIN - CHICAGO MERCANTILE EXCHANGE$/, "BTC"],
  [/^ETHER\b[^-]* - CHICAGO MERCANTILE EXCHANGE$/, "ETH"],
]
const COT_WHERE = "market_and_exchange_names like '%CHICAGO MERCANTILE EXCHANGE' AND (contract_market_name = 'BITCOIN' OR contract_market_name like 'ETHER%')"

const contracts = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}`

/** Latest report per market → one item each: leveraged funds' and asset managers' net positions and their weekly change. */
export const cotItems = (rows: CotRow[], ctx: SourceContext): RawItem[] => {
  const universe = universeBases(ctx)
  const items: RawItem[] = []
  for (const [re, base] of COT_MARKETS) {
    const latest = rows.filter((r) => re.test(r.market_and_exchange_names ?? "")).sort((a, b) => (b.report_date_as_yyyy_mm_dd ?? "").localeCompare(a.report_date_as_yyyy_mm_dd ?? ""))[0]
    const symbol = universe.get(base)
    if (!latest || !symbol) continue
    const n = (k: string) => Number(latest[k] ?? 0)
    const date = (latest.report_date_as_yyyy_mm_dd ?? "").slice(0, 10)
    const lev = n("lev_money_positions_long") - n("lev_money_positions_short")
    const levChange = n("change_in_lev_money_long") - n("change_in_lev_money_short")
    const am = n("asset_mgr_positions_long") - n("asset_mgr_positions_short")
    const amChange = n("change_in_asset_mgr_long") - n("change_in_asset_mgr_short")
    items.push({
      sourceId: `${date}:${base}`,
      title: `CFTC COT (${date}): CME ${base === "BTC" ? "bitcoin" : "ether"} futures, leveraged funds net ${contracts(lev)} contracts (${contracts(levChange)} on the week), asset managers net ${contracts(am)} (${contracts(amChange)})`,
      url: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
      symbols: [symbol],
      category: "general",
      kind: "derivatives",
      polarity: 0,
      // Weekly positioning: context, low enough that it never triggers anything.
      baseSeverity: 20,
      meta: { report_date: date, contract_units: latest.contract_units ?? null, open_interest: n("open_interest_all"), lev_net: lev, lev_net_change: levChange, asset_mgr_net: am, asset_mgr_net_change: amChange },
    })
  }
  return items
}

/** Social lists approved by the owner. All tier 3: they feed the dossier. */
const TELEGRAM_CHANNELS = ["WatcherGuru", "whale_alert_io", "wublockchainenglish", "cointelegraph"]
const BLUESKY_ACCOUNTS = ["coindesk.com", "decrypt.co", "protos.com", "web3isgoinggreat.com", "molly.wiki", "bloomberg.com", "reuters.com", "apnews.com", "wsj.com", "cnbc.com", "axios.com", "politico.com"]
/** The general outlets post about everything: only crypto posts go further (the pipeline's relevance filter still applies). */
const BLUESKY_KEYWORDS = /\b(bitcoin|ethereum|ether|crypto\w*|solana|xrp|ripple|dogecoin|cardano|chainlink|avalanche|litecoin|polkadot|stablecoins?|tether|usdc|coinbase|binance|kraken|defi|blockchain|web3)\b|\$(BTC|ETH|SOL|XRP|DOGE|ADA|LINK|AVAX|LTC|DOT)\b/i
/** Research and narrative newsletters (verified from the server 2026-10-26): context for the dossier, polled every 15 min. */
const NEWSLETTERS: [string, string][] = [
  ["glassnode", "https://research.glassnode.com/rss/"],
  ["unchained", "https://unchainedcrypto.com/feed/"],
  ["bankless", "https://www.bankless.com/rss/feed"],
  ["defiant", "https://thedefiant.io/api/feed"],
  ["arthur_hayes", "https://cryptohayes.substack.com/feed"],
]

export const CATALOG: SourceSpec[] = [
  // ── Venues (tier 1) ───────────────────────────────────────────────────────
  {
    id: "kraken_pairs",
    kind: "diff",
    url: "https://api.kraken.com/0/public/AssetPairs",
    interval_s: 60,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    entries: (body) => {
      const r = (body as KrakenPairs).result ?? {}
      const out = new Map<string, string>()
      for (const p of Object.values(r)) if (p.wsname && (p.quote === "ZUSD" || p.quote === "USD")) out.set(krakenSymbol(p.wsname), p.status ?? "online")
      return out
    },
    describe: ({ type, key, before, after }): RawItem | null => {
      if (type === "added") return { sourceId: `added:${key}:${after}`, title: `Kraken adds ${key} trading (status ${after})`, symbols: [key], category: "listing_major", polarity: 1, baseSeverity: 40, url: "https://status.kraken.com" }
      if (type === "removed") return { sourceId: `removed:${key}`, title: `Kraken no longer lists ${key}`, symbols: [key], category: "venue_status", polarity: -1, url: "https://status.kraken.com" }
      return { sourceId: `status:${key}:${after}`, title: `Kraken ${key} status changed from ${before} to ${after}`, symbols: [key], category: "venue_status", polarity: after === "online" ? 1 : -1, url: "https://status.kraken.com" }
    },
  },
  { id: "status_kraken", kind: "statuspage", url: "https://status.kraken.com/api/v2/summary.json", interval_s: 60, tier: 1, wire_kind: "venue", default_enabled: true },
  { id: "status_coinbase", kind: "statuspage", url: "https://status.coinbase.com/api/v2/summary.json", interval_s: 60, tier: 1, wire_kind: "venue", default_enabled: true },

  // ── Crypto outlets (tier 2) ───────────────────────────────────────────────
  rss("rss:coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss", 60, 2),
  rss("rss:theblock", "https://www.theblock.co/rss.xml", 60, 2),
  rss("rss:decrypt", "https://decrypt.co/feed", 60, 2),
  rss("rss:cointelegraph", "https://cointelegraph.com/rss", 60, 2),
  rss("rss:blockworks", "https://blockworks.com/feed", 60, 2),
  rss("rss:thedefiant", "https://thedefiant.io/api/feed", 90, 2),
  {
    id: "finnhub_crypto",
    kind: "json",
    url: "https://finnhub.io/api/v1/news?category=crypto",
    interval_s: 60,
    tier: 2,
    key_env: "FINNHUB_API_KEY",
    default_enabled: true,
    headers: (env) => ({ "X-Finnhub-Token": env.FINNHUB_API_KEY ?? "" }),
    map: (body) =>
      (Array.isArray(body) ? (body as FinnhubNews[]) : []).slice(0, 100).map((n) => ({
        sourceId: String(n.id),
        title: n.headline,
        summary: n.summary,
        url: n.url,
        publishedAt: unixDate(n.datetime),
        meta: { publisher: n.source },
      })),
  },

  // ── Government and regulators (tier 1) ────────────────────────────────────
  SHARED["gov:sec_press"],
  SHARED["gov:sec_litigation"],
  SHARED["gov:sec_suspensions"],
  rss("gov:cftc", "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", 180, 1, { category_hint: "regulatory_action" }),
  SHARED["gov:doj"],
  SHARED["gov:ofac"],
  SHARED["gov:fed"],
  SHARED["gov:whitehouse"],

  // ── Broad coverage and primary statements ────────────────────────────────
  rss("gnews", "https://news.google.com/rss", 30, 3, {
    symbols: "universe",
    urlFor: (symbol) => {
      const base = symbol.split("/")[0]
      const q = SEARCH_NAMES[base] ?? `${base} crypto`
      return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1h&hl=en-US&gl=US&ceid=US:en`
    },
  }),
  SHARED.truth_social,

  // ── Calendars ─────────────────────────────────────────────────────────────
  SHARED.macro_ff,

  // ════ Wave 2 ═══════════════════════════════════════════════════════════════

  // ── Venues and exchanges (tier 1) ─────────────────────────────────────────
  {
    id: "coinbase_products",
    kind: "diff",
    url: "https://api.exchange.coinbase.com/products",
    // ~200 KB a poll: every two minutes is plenty for listings.
    interval_s: 120,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    note: "Coinbase Exchange products: a new USD product for a universe asset is a listing; a status change is venue status",
    entries: (body) => {
      const out = new Map<string, string>()
      for (const p of Array.isArray(body) ? (body as CoinbaseProduct[]) : []) if (p.quote_currency === "USD") out.set(`${p.base_currency}/USD`, `${p.status}${p.trading_disabled ? ", trading disabled" : ""}`)
      return out
    },
    describe: ({ type, key, before, after }, ctx): RawItem | null => {
      // Every USD product is tracked (so a pair the owner adds later isn't mistaken for a listing); only universe assets become items.
      if (!ctx.symbols().universe.includes(key)) return null
      const url = `https://exchange.coinbase.com/trade/${key.replace("/", "-")}`
      if (type === "added") return { sourceId: `added:${key}`, title: `Coinbase lists ${key} (new ${key.replace("/", "-")} product, ${after})`, symbols: [key], category: "listing_major", polarity: 1, url }
      if (type === "removed") return { sourceId: `removed:${key}`, title: `Coinbase no longer lists ${key}`, symbols: [key], category: "venue_status", polarity: -1, url }
      return { sourceId: `status:${key}:${after}`, title: `Coinbase ${key} status changed from ${before} to ${after}`, symbols: [key], category: "venue_status", polarity: after === "online" ? 1 : -1, url }
    },
  },
  { id: "status_solana", kind: "statuspage", url: "https://status.solana.com/api/v2/summary.json", interval_s: 120, tier: 1, wire_kind: "venue", default_enabled: true, note: "Solana network status (titles name Solana, so items are tagged SOL)" },
  rss("blog:kraken", "https://blog.kraken.com/feed", 120, 1, { wire_kind: "venue" }),
  {
    id: "binance_announcements",
    kind: "telegram",
    channel: "binance_announcements",
    interval_s: 60,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    refine: binanceAnnouncements,
    note: "Binance's official announcements channel (t.me/s preview): listings, delistings and notices that name a universe asset",
  },

  // ── Social (tier 3, owner-approved lists) ───────────────────────────────
  ...TELEGRAM_CHANNELS.map((channel): SourceSpec => ({ id: `telegram:${channel}`, kind: "telegram", channel, interval_s: 30, tier: 3, default_enabled: true })),
  blueskySpec({ accounts: BLUESKY_ACCOUNTS, keywords: BLUESKY_KEYWORDS }),
  ...NEWSLETTERS.map(([name, url]) => rss(`newsletter:${name}`, url, 900, 3)),

  // ── Client releases (tier 1, upgrades) ────────────────────────────────────
  rss("gh:bitcoin", "https://github.com/bitcoin/bitcoin/releases.atom", 900, 1, { category_hint: "upgrade", refine: githubReleases("BTC", "Bitcoin Core") }),
  rss("gh:geth", "https://github.com/ethereum/go-ethereum/releases.atom", 900, 1, { category_hint: "upgrade", refine: githubReleases("ETH", "Geth") }),
  rss("gh:agave", "https://github.com/anza-xyz/agave/releases.atom", 900, 1, { category_hint: "upgrade", refine: githubReleases("SOL", "Agave (Solana validator)") }),
  rss("gh:rippled", "https://github.com/XRPLF/rippled/releases.atom", 900, 1, { category_hint: "upgrade", refine: githubReleases("XRP", "rippled (XRP Ledger)") }),
  rss("gh:cardano", "https://github.com/IntersectMBO/cardano-node/releases.atom", 900, 1, { category_hint: "upgrade", refine: githubReleases("ADA", "cardano-node") }),

  // ── Central banks and rules (tier 1) ──────────────────────────────────────
  SHARED["cb:ecb"],
  SHARED["cb:boe"],
  SHARED["cb:boj"],
  fedreg("fedreg", '"digital asset"'),
  fedreg("fedreg:stablecoin", "stablecoin"),
  SHARED.macro_actuals,

  // ── More outlets: Bitcoin Magazine, CryptoSlate, DL News, Protos, Unchained (tier 2), the rest tier 3 ──
  rss("rss:bitcoinmagazine", "https://bitcoinmagazine.com/.rss/full/", 90, 2),
  rss("rss:cryptoslate", "https://cryptoslate.com/feed/", 90, 2),
  rss("rss:dlnews", "https://www.dlnews.com/arc/outboundfeeds/rss/", 90, 2),
  rss("rss:protos", "https://protos.com/feed/", 120, 2),
  rss("rss:unchained", "https://unchainedcrypto.com/feed/", 120, 2),
  rss("rss:cryptobriefing", "https://cryptobriefing.com/feed/", 120, 3),
  rss("rss:beincrypto", "https://beincrypto.com/feed/", 120, 3),
  rss("rss:bitcoinist", "https://bitcoinist.com/feed/", 120, 3),
  rss("rss:newsbtc", "https://www.newsbtc.com/feed/", 120, 3),
  rss("rss:dailyhodl", "https://dailyhodl.com/feed/", 120, 3),
  {
    id: "gdelt",
    kind: "json",
    // GDELT rejects 30 minutes as "too short"; an hour overlaps polls, and dedupe drops the repeats.
    url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(GDELT_QUERY)}&mode=artlist&format=json&maxrecords=75&timespan=1h&sort=datedesc`,
    interval_s: 300,
    tier: 3,
    default_enabled: true,
    note: "GDELT DOC 2.0 (keyless; one request per 5 s, enforced by the limiter; often answers 429 or times out, so it degrades and backs off): global breadth and confirmation, minutes to hours behind",
    map: (body) =>
      ((body as { articles?: GdeltArticle[] }).articles ?? []).map((a) => ({
        title: a.title,
        url: a.url,
        publishedAt: gdeltDate(a.seendate),
        meta: { language: a.language ?? null, country: a.sourcecountry ?? null },
      })),
  },

  // ── Positioning ───────────────────────────────────────────────────────────
  {
    id: "cot",
    kind: "json",
    url: `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$where=${encodeURIComponent(COT_WHERE)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=8`,
    // Weekly (Friday afternoon); hourly looks are cheap and catch it soon after.
    interval_s: 3_600,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "CFTC Traders in Financial Futures (Socrata, keyless): CME bitcoin and ether futures; one item per report and market",
    map: (body, ctx) => cotItems(Array.isArray(body) ? (body as CotRow[]) : [], ctx),
  },
  ...DERIVATIVES_SOURCES,
  ...DEFILLAMA_SOURCES,
  ...ODDS_SOURCES,

  // ── Network stress and attention ──────────────────────────────────────────
  ...CHAIN_SOURCES,
  ...ATTENTION_SOURCES,

  // ════ Wave 3 (terms and robots.txt checked) ════════════════════════════
  // Plain JSON and HTML: none of the allowed sites needs the scraper sidecar yet.
  ...KOREA_SOURCES,
  HACKS_SOURCE,
]
