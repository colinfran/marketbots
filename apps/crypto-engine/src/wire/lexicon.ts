import type { WireCategory } from "@mb/crypto-core/wire"
import type { Lexicon } from "./types"

/**
 * Crypto language rules for the news engine: which pair a headline is about, what kind of event
 * it describes, and which way it probably cuts. Deterministic and deliberately simple; the AI
 * judges what an item means, these rules only route and rank it.
 *
 * Ambiguous tickers (SOL, ADA, LINK, DOT…) are ordinary words, so they match only as a cashtag
 * ($SOL) or by the project's name ("Solana"). Pairs the owner adds to the universe without an
 * entry here match by cashtag or by the ticker in capitals.
 */

/** `not`: uses of a name that mean something else, removed before the name is looked for. */
type Alias = { names: string[]; ticker: "plain" | "ambiguous"; not?: RegExp }

const ASSETS: Record<string, Alias> = {
  BTC: { names: ["bitcoin", "btc", "xbt"], ticker: "plain" },
  ETH: { names: ["ethereum", "ether", "eth"], ticker: "plain" },
  SOL: { names: ["solana"], ticker: "ambiguous" },
  XRP: { names: ["xrp", "ripple"], ticker: "plain" },
  // DOGE is also the Department of Government Efficiency ("Musk's DOGE staffers…").
  DOGE: {
    names: ["dogecoin", "doge"],
    ticker: "plain",
    not: /department of government efficiency( \(doge\))?|\bdoge(?=(['’]s)?\s+(staff\w*|cuts?|team|department|employees|office|chief|head|savings|layoffs?|officials?|agents?|workers?|access|aides?|engineers?|members?|era|initiative|efforts?|reforms?|operatives?|website|audits?|contracts?|panel|commission)\b)|\b(elon )?musk['’]s doge\b/gi,
  },
  ADA: { names: ["cardano"], ticker: "ambiguous" },
  LINK: { names: ["chainlink"], ticker: "ambiguous" },
  AVAX: { names: ["avalanche", "avax"], ticker: "plain" },
  LTC: { names: ["litecoin", "ltc"], ticker: "plain" },
  DOT: { names: ["polkadot"], ticker: "ambiguous" },
  USDT: { names: ["tether", "usdt"], ticker: "plain" },
  USDC: { names: ["usdc", "usd coin"], ticker: "plain" },
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const matcherCache = new Map<string, (text: string) => boolean>()

const matcherFor = (symbol: string) => {
  const cached = matcherCache.get(symbol)
  if (cached) return cached
  const base = symbol.split("/")[0].toUpperCase()
  const alias = ASSETS[base]
  const cashtag = new RegExp(`(^|[^\\w$])\\$${escape(base)}\\b`, "i")
  const names = alias ? new RegExp(`\\b(${alias.names.map(escape).join("|")})\\b`, "i") : null
  // Unknown assets: the ticker in capitals (case-sensitive), if it isn't too short to be a word.
  const plain = !alias && base.length >= 3 ? new RegExp(`\\b${escape(base)}\\b`) : null
  const fn = (text: string) => cashtag.test(text) || (!!names && names.test(alias?.not ? text.replace(alias.not, " ") : text)) || (!!plain && plain.test(text))
  matcherCache.set(symbol, fn)
  return fn
}

/** First match wins, so the most specific categories come first. */
const RULES: [WireCategory, RegExp][] = [
  ["exploit", /\b(hack(ed|ers?|s)?|exploit(ed|s)?|drain(ed|s)?|stolen|theft|attackers?|compromised|rug ?pull)\b/i],
  ["depeg", /\b(de-?peg(ged|s)?|loses? (its )?peg|lost (its )?peg|breaks? (its )?peg)\b/i],
  ["etf_decision", /\betfs?\b.*\b(approv\w*|reject\w*|den(y|ies|ied)|delay\w*|decision|19b-4|launch(es|ed)?)\b|\b(approv\w*|reject\w*|den(y|ies|ied)|delay\w*)\b.*\betfs?\b/i],
  ["listing_major", /\b(coinbase|upbit|bithumb|robinhood)\b.*\b(lists?|listing|listed|adds?|added|will support|now available)\b|\b(lists?|listing|adds?)\b.*\bon (coinbase|upbit|bithumb|robinhood)\b/i],
  ["venue_outage", /\b(outage|downtime|halt(s|ed)? (withdrawals|trading|deposits)|suspend(s|ed)? (withdrawals|trading|deposits)|pauses? (withdrawals|trading))\b/i],
  [
    "regulatory_action",
    /\b(sec|cftc|doj|justice department|ofac|irs|white house|executive order|congress|senate|lawsuit|sues|sued|charges|charged|indict\w*|enforcement|settles?|settlement|bans?|banned|sanction\w*|subpoena\w*|regulators?|regulation|legislation|stablecoin bill|market structure bill)\b/i,
  ],
  ["treasury_buy", /\b(adds?|buys?|bought|acquires?|acquired|purchases?|purchased)\b.*\b(btc|bitcoin|eth|ether)\b|\bstrategic (bitcoin|crypto) reserve\b/i],
  ["unlock_large", /\btoken unlocks?\b|\bunlocks? \$?[\d.]+ ?(m|b|million|billion)\b/i],
  ["macro_release", /\b(cpi|inflation data|jobs report|nonfarm|payrolls|unemployment rate|fomc|rate (cut|hike|decision)|fed (cuts|hikes|holds)|pce|gdp)\b/i],
  ["upgrade", /\b(upgrade|hard ?fork|mainnet|network upgrade|activation|client release)\b|\brelease[sd]? v?\d+\.\d+/i],
  ["partnership", /\b(partner(s|ship|ed)?|collaborat\w*|integrat(es|ed|ion)|teams up)\b/i],
]

const NEGATIVE = /\b(hack\w*|exploit\w*|drain\w*|stolen|sues|sued|lawsuit|charge[sd]|indict\w*|ban(s|ned)?|delist\w*|outage|plunge\w*|crash\w*|tumble\w*|slump\w*|falls?|fell|drops?|dropped|sinks?|liquidat\w*|reject\w*|den(y|ies|ied)|sanction\w*|fraud|collapse\w*|bankrupt\w*|halt\w*|suspend\w*|outflows?|sell-?off|warns?|probe|investigat\w*|depeg\w*|loses?)\b/i
const POSITIVE = /\b(approv\w*|launch\w*|lists?|listing|surge\w*|soar\w*|rall(y|ies|ied)|jumps?|record high|all-time high|adopt\w*|partner\w*|inflows?|buys?|bought|acquir\w*|upgrade[sd]?|gains?|climbs?|wins?|won|clears?|cleared)\b/i

const CRYPTO_CONTEXT = /\b(crypto\w*|bitcoin|btc|ether(eum)?|stablecoins?|digital assets?|tokens?|blockchain|defi|web3|altcoins?|on-?chain)\b/i
const MACRO_POLICY = /\b(fomc|powell|interest rates?|rate (cut|hike)s?|inflation|cpi|jobs report|payrolls|recession|tariffs?|trade war|treasury yields?|dollar index|government shutdown)\b/i
const MARKET_CATEGORIES = new Set<WireCategory>(["regulatory_action", "etf_decision", "macro_release", "exploit", "depeg", "venue_outage", "venue_status", "listing_major"])

/** Security news that isn't an attack on funds: flaws found and fixed, research, warnings. */
const SECURITY_RESEARCH = /\b(flaws?|bugs?|vulnerabilit(y|ies)|patch(es|ed)?|fix(es|ed)?|security polic(y|ies)|researchers?|bug bounty|bount(y|ies)|challenge|could be hacked|warns?|quantum)\b/i

const MULTIPLIER: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }
const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|b|bn|thousand|million|billion)?\b|\b(\d[\d,]*(?:\.\d+)?)\s?(million|billion)\s+(?:in\s+)?(?:usd|usdt|usdc|dollars)\b/gi

/** The largest dollar amount a headline mentions ("$2.6M", "$947,000", "4.85 million USDT"), or null. */
export const largestAmountUsd = (text: string): number | null => {
  let max: number | null = null
  for (const m of text.matchAll(DOLLARS)) {
    const value = Number((m[1] ?? m[3]).replace(/,/g, "")) * (MULTIPLIER[(m[2] ?? m[4] ?? "").toLowerCase()] ?? 1)
    if (Number.isFinite(value)) max = Math.max(max ?? 0, value)
  }
  return max
}

export const cryptoLexicon: Lexicon = {
  tag: (text, symbols) => symbols.filter((s) => matcherFor(s)(text)),
  classify: (text, hint) => RULES.find(([, re]) => re.test(text))?.[0] ?? hint ?? "general",
  polarity: (text) => {
    const neg = NEGATIVE.test(text)
    const pos = POSITIVE.test(text)
    return neg === pos ? 0 : neg ? -1 : 1
  },
  marketWide: (text, category) => category === "depeg" || MACRO_POLICY.test(text) || (MARKET_CATEGORIES.has(category) && CRYPTO_CONTEXT.test(text)),
  // Kraken volume is real exchange volume, so a volume anomaly counts as much as a price one.
  volumeAnomalyPoints: 15,
  // Hacks happen weekly; a $1M drain of a small protocol isn't a $500M exchange hack. A real hack
  // report nearly always names the amount; without one it's an early report (60, so tier 1 alone
  // reviews and tier 2 needs a confirmation or a price move) or security research and fixes (30).
  baseSeverity: (text, category) => {
    if (category !== "exploit") return undefined
    const usd = largestAmountUsd(text)
    if (usd === null) return SECURITY_RESEARCH.test(text) ? 30 : 60
    return usd >= 100e6 ? 90 : usd >= 10e6 ? 70 : 40
  },
}
