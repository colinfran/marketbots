import type { WireCategory } from "@mb/stock-core/wire"
import type { Lexicon } from "./types"

/**
 * Stock language rules for the news engine: which tickers a headline is about, what kind of
 * event it describes, and which way it probably cuts. Deterministic and deliberately simple; the
 * AI judges what an item means, these rules only route and rank it.
 *
 * Tickers match as a cashtag ($NVDA), an exchange tag ("(NASDAQ: NVDA)"), or the ticker in
 * capitals as its own word, except tickers that are everyday words in capitals (A, IT, ALL, NOW…),
 * which need one of the first two forms.
 */

/** Tickers that are common words or abbreviations when written in capitals. */
const AMBIGUOUS = new Set(
  "A AN AM ARE AS AT BE BIG BY CAN CEO CFO CEOS CPI DD DO EV EPS ETF FDA FOR GDP GO HAS HE IPO IT ITS KEY LOW MAN NEW NOW OK ON ONE OR OUT PM POST REAL RUN SAFE SEE SO SEC THE TV TWO UK UP US USA WELL ALL ANY CASH FAST FUN GOOD HOPE LIFE LOVE MAIN MORE NEXT OPEN PLAY RIDE SAVE SHOP SKY STAY TRUE WORK YOU".split(" "),
)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const tickerMatcher = new Map<string, (text: string) => boolean>()

const matcherFor = (symbol: string) => {
  const cached = tickerMatcher.get(symbol)
  if (cached) return cached
  const t = escape(symbol.toUpperCase())
  const cashtag = new RegExp(`(^|[^\\w$])\\$${t}\\b`, "i")
  const exchange = new RegExp(`\\((?:NASDAQ|NYSE|NYSE American|NYSE Arca|AMEX|OTC|OTCQX|OTCQB|Cboe)\\s*:\\s*${t}\\)`, "i")
  const plain = AMBIGUOUS.has(symbol.toUpperCase()) || symbol.length < 2 ? null : new RegExp(`(^|[^A-Za-z0-9$])${t}(?![A-Za-z0-9])`)
  const fn = (text: string) => cashtag.test(text) || exchange.test(text) || (!!plain && plain.test(text))
  tickerMatcher.set(symbol, fn)
  return fn
}

/** First match wins, so the most specific categories come first. */
const RULES: [WireCategory, RegExp][] = [
  ["bankruptcy", /\b(chapter 11|chapter 7|files? for bankruptcy|bankruptcy (filing|protection)|insolvency)\b/i],
  ["restatement", /\b(restate(s|d|ment)?|non-reliance|should no longer be relied upon)\b/i],
  ["delisting_notice", /\b(delist\w*|notice of (non-?compliance|delisting)|minimum bid price|form 25)\b/i],
  ["halt", /\b(trading halt(ed)?|halts? trading|trading (is )?suspended|resum(es|ption of) trading)\b/i],
  ["late_filing", /\b(nt 10-[kq]|late filing|unable to (timely )?file|notification of late filing)\b/i],
  ["short_report", /\b(short[- ]seller|short report|hindenburg|muddy waters|citron research|grizzly research|spruce point)\b/i],
  ["fda", /\b(fda (approv\w*|accept\w*|clear\w*|grants?|rejects?)|pdufa|complete response letter|crl\b|breakthrough (therapy )?designation|clinical hold|fast track designation|advisory committee)\b/i],
  ["m_and_a", /\b(to acquire|acquisition of|agrees? to (buy|acquire|merge)|merger agreement|definitive agreement|takeover|tender offer|buyout|to be acquired|go(es|ing)? private)\b/i],
  ["offering", /\b(public offering|proposed offering|prices? (its )?(offering|\$)|private placement|at-the-market|atm (program|offering)|convertible (senior )?notes|registered direct|secondary offering)\b/i],
  ["guidance", /\b(guidance|outlook|forecast|raises (its )?(full[- ]year )?(revenue|sales|earnings)|lowers (its )?(full[- ]year )?(revenue|sales|earnings)|reaffirms|preannounce\w*)\b/i],
  ["index_change", /\b(join(s|ing)? the s&p|added to the s&p|s&p (500|midcap 400|smallcap 600) (index )?(addition|inclusion)|index rebalanc\w*|set to join)\b/i],
  ["cyber_incident", /\b(cybersecurity incident|data breach|ransomware|cyberattack|cyber attack|hack(ed)?)\b/i],
  ["antitrust", /\b(antitrust|anti-trust|monopol\w*|competition (authority|regulator)|ftc (sues|challenges|blocks)|doj (sues|antitrust))\b/i],
  ["exec_departure", /\b(resign\w*|steps? down|depart\w*|retire\w*|ousted|fired)\b.*\b(ceo|cfo|chief|president|chair\w*)\b|\b(ceo|cfo)\b.*\b(resign\w*|steps? down|to depart)\b/i],
  ["earnings", /\b(earnings|quarterly results|(first|second|third|fourth)[- ]quarter (results|revenue)|q[1-4] (results|earnings|revenue)|eps|beats? estimates|misses? estimates)\b/i],
  // Most executive orders and sanctions programs don't move US stocks; trade measures and big-economy sanctions do.
  ["policy_shock", /\b(tariffs?|export controls?|entity list|trade war|section 232|section 301|chip curbs?)\b|\bsanctions (on|against) (china|chinese|russia|russian|iran)\b/i],
  ["macro_release", /\b(cpi|inflation data|jobs report|nonfarm|payrolls|unemployment rate|fomc|rate (cut|hike|decision)|fed (cuts|hikes|holds)|pce|gdp|retail sales|ppi)\b/i],
  ["analyst_action", /\b(upgrade[sd]?|downgrade[sd]?|price target|initiates? coverage|reiterates?|overweight|underweight|outperform|underperform)\b/i],
  ["insider_buy", /\b(insider (buy|purchase)\w*|director (buys|purchases)|ceo (buys|purchases)|form 4)\b/i],
  ["lawsuit", /\b(class action|lawsuit|sues|sued|litigation|securities fraud)\b/i],
  ["regulatory_action", /\b(sec charges|sec settles|cease-and-desist|consent order|enforcement action|penalt(y|ies)|fined)\b/i],
]

/** EDGAR 8-K items → category (the most material item of a filing decides). */
export const EIGHT_K_ITEMS: Record<string, WireCategory> = {
  "1.03": "bankruptcy",
  "4.02": "restatement",
  "3.01": "delisting_notice",
  "1.05": "cyber_incident",
  "2.02": "earnings",
  "5.02": "exec_departure",
  "2.01": "m_and_a",
  "1.01": "general",
  "2.05": "guidance",
  "2.06": "guidance",
  "3.02": "offering",
}

/** Order of materiality for picking a filing's category. */
export const ITEM_PRIORITY = ["1.03", "4.02", "3.01", "1.05", "2.01", "2.02", "5.02", "2.05", "2.06", "3.02", "1.01"]

const NEGATIVE =
  /\b(miss(es|ed)?|cuts?|lowers?|lowered|downgrade[sd]?|plunge\w*|tumble\w*|slump\w*|sinks?|falls?|fell|drops?|dropped|bankrupt\w*|delist\w*|restate\w*|resign\w*|lawsuit|sued|probe|investigat\w*|recall\w*|halt\w*|suspend\w*|warns?|layoffs?|dilut\w*|offering|complete response letter|rejects?|rejected|short[- ]seller|fraud|default\w*|breach)\b/i
const POSITIVE =
  /\b(beats?|tops|raises?|raised|upgrade[sd]?|approv\w*|surge\w*|soar\w*|jumps?|rall(y|ies|ied)|record|buyback|repurchase|dividend increase|to be acquired|acquired by|join(s|ing)? the s&p|wins?|won|awarded|contract|breakthrough|strong demand)\b/i

const MARKET_WIDE = /\b(federal reserve|fomc|powell|interest rates?|rate (cut|hike)s?|inflation|cpi|jobs report|payrolls|recession|tariffs?|trade war|export controls?|treasury yields?|government shutdown|debt ceiling|stock market|wall street|s&p 500 (falls|rises|drops|jumps))\b/i
const MARKET_CATEGORIES = new Set<WireCategory>(["macro_release", "policy_shock"])

export const stockLexicon: Lexicon = {
  tag: (text, symbols) => symbols.filter((s) => matcherFor(s)(text)),
  classify: (text, hint) => RULES.find(([, re]) => re.test(text))?.[0] ?? hint ?? "general",
  polarity: (text) => {
    const neg = NEGATIVE.test(text)
    const pos = POSITIVE.test(text)
    return neg === pos ? 0 : neg ? -1 : 1
  },
  marketWide: (text, category) => MARKET_CATEGORIES.has(category) || MARKET_WIDE.test(text),
  // IEX volume is a small slice of real volume, so a volume-only anomaly counts for little.
  volumeAnomalyPoints: 5,
}
