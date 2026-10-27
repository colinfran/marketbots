import type { SourceContext } from "../types"

/**
 * Company names → tickers, for sources that name companies instead of tickers: openFDA sponsors,
 * FDA advisory-committee agendas, ClinicalTrials.gov sponsors, USAspending recipients, GDELT and
 * Wikipedia lookups.
 *
 * The SEC's company_tickers.json (every registered company's ticker, CIK and name; loaded once a
 * day and shared with EDGAR) is the directory. Names are normalized the same way on both sides:
 * upper case, "&" → AND, punctuation and state suffixes (/DE/) dropped, the abbreviations the FDA
 * uses spelled out (PHARMS, LABS, THERAP…), and trailing corporate words (Inc, Corp, Co, Holdings,
 * Group…) removed. A name then matches a company when the company's whole normalized name is the
 * start of it ("NOVARTIS PHARMS CORP" → Novartis AG), or when it is the start of exactly one
 * company's name ("HUNTINGTON INGALLS INC" → Huntington Ingalls Industries). A single short or
 * generic word ("UCB", "American") never matches on its own. Subsidiaries and brands that file
 * under a parent with another name (Janssen → JNJ, Optum → UNH, Raytheon → RTX) are in ALIASES.
 */

const DAY_MS = 86_400_000
const SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"

type TickerFile = Record<string, { cik_str: number; ticker: string; title: string }>
export type CompanyRow = { cik: number; ticker: string; title: string }

const ABBREV: Record<string, string> = {
  PHARMS: "PHARMACEUTICALS",
  PHARMA: "PHARMACEUTICALS",
  PHARM: "PHARMACEUTICALS",
  PHARMACEUTICAL: "PHARMACEUTICALS",
  LABS: "LABORATORIES",
  LAB: "LABORATORIES",
  THERAP: "THERAPEUTICS",
  THERAPEUTIC: "THERAPEUTICS",
  INTL: "INTERNATIONAL",
  HLTHCARE: "HEALTHCARE",
  MFG: "MANUFACTURING",
  SVCS: "SERVICES",
  BIOSCIENCE: "BIOSCIENCES",
  CORPORATION: "CORP",
  INCORPORATED: "INC",
  COMPANY: "CO",
  LIMITED: "LTD",
}

/** Corporate words that say nothing about which company it is, dropped from the end of a name. */
const TRAILING = new Set(["INC", "CORP", "CO", "LTD", "PLC", "LLC", "LP", "LLP", "SA", "AG", "NV", "SE", "AB", "ASA", "SPA", "HOLDINGS", "HOLDING", "GROUP", "INDUSTRIES", "ADR", "ADS", "NEW", "THE", "AND", "OF", "US", "USA", "NA", "COM"])

/** First words too common to identify a company alone. */
const GENERIC = new Set(
  "AMERICAN NATIONAL GENERAL UNITED FIRST GLOBAL INTERNATIONAL PACIFIC ATLANTIC ADVANCED APPLIED INTEGRATED DIGITAL UNIVERSAL CENTRAL CAPITAL MEDICAL HEALTH SCIENCE SCIENCES BIO PHARMACEUTICALS LABORATORIES THERAPEUTICS ROYAL STANDARD SOUTHERN NORTHERN WESTERN EASTERN ALLIED CONTINENTAL SECURITY STAR SUN GREAT NORTH SOUTH WEST EAST NEW CITY STATE TRUST BANK DATA ENERGY POWER".split(" "),
)

/** Names whose listed parent files under another name, as normalized leading words → ticker. */
const ALIASES: [string, string][] = [
  ["JANSSEN", "JNJ"],
  ["JOHNSON AND JOHNSON", "JNJ"],
  ["MERCK SHARP", "MRK"],
  ["ELI LILLY", "LLY"],
  ["LILLY", "LLY"],
  ["GENZYME", "SNY"],
  ["SANOFI", "SNY"],
  ["NOVO NORDISK", "NVO"],
  ["ASTRAZENECA", "AZN"],
  ["ALEXION", "AZN"],
  ["GLAXOSMITHKLINE", "GSK"],
  ["VIIV", "GSK"],
  ["BRISTOL MYERS", "BMY"],
  ["E R SQUIBB", "BMY"],
  ["CELGENE", "BMY"],
  ["KITE PHARMACEUTICALS", "GILD"],
  ["ALLERGAN", "ABBV"],
  ["PHARMACYCLICS", "ABBV"],
  ["WYETH", "PFE"],
  ["HOSPIRA", "PFE"],
  ["SEAGEN", "PFE"],
  ["HORIZON THERAPEUTICS", "AMGN"],
  ["MODERNATX", "MRNA"],
  ["MODERNA", "MRNA"],
  ["BIONTECH", "BNTX"],
  ["OPTUM", "UNH"],
  ["UNITEDHEALTH", "UNH"],
  ["RAYTHEON", "RTX"],
  ["PRATT AND WHITNEY", "RTX"],
  ["COLLINS AEROSPACE", "RTX"],
  ["SIKORSKY", "LMT"],
  ["ELECTRIC BOAT", "GD"],
  ["BATH IRON WORKS", "GD"],
  ["GULFSTREAM AEROSPACE", "GD"],
  ["L3HARRIS", "LHX"],
  ["L3 HARRIS", "LHX"],
  ["HEALTH NET FEDERAL", "CNC"],
  ["AMAZON WEB SERVICES", "AMZN"],
  ["GOOGLE", "GOOGL"],
  ["PALANTIR", "PLTR"],
  ["ACCENTURE FEDERAL", "ACN"],
  ["INTERNATIONAL BUSINESS MACHINES", "IBM"],
  ["GE AEROSPACE", "GE"],
  ["GE HEALTHCARE", "GEHC"],
  ["MYLAN", "VTRS"],
  ["VIATRIS", "VTRS"],
  ["BAXTER", "BAX"],
  ["AMERISOURCEBERGEN", "COR"],
  ["CENCORA", "COR"],
  // Names too short to match on their own.
  ["KBR", "KBR"],
  ["CACI", "CACI"],
  ["JACOBS", "J"],
  ["DELL", "DELL"],
  ["V2X", "VVX"],
]

/** A name as normalized words (see the module comment). */
export const normalizeName = (name: string): string[] => {
  const words = name
    .toUpperCase()
    .replace(/&/g, " AND ")
    // State of incorporation: "INC /DE/", "INC / MA".
    .replace(/\s*\/\s*[A-Z]{2,3}\b\/?/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => ABBREV[w] ?? w)
  if (words[0] === "THE") words.shift()
  while (words.length > 1 && TRAILING.has(words[words.length - 1])) words.pop()
  return words
}

/** "NVIDIA CORP" → "Nvidia", "Vertex Pharmaceuticals Inc" → "Vertex Pharmaceuticals", "IBM" stays (for search queries and title matching). */
export const shortName = (title: string) =>
  normalizeName(title)
    .map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ")

const distinctive = (w: string) => w.length >= 4 && !GENERIC.has(w) && !/^\d/.test(w)
const startsWith = (words: string[], prefix: string[]) => prefix.length <= words.length && prefix.every((w, i) => words[i] === w)

const ALIAS_WORDS = ALIASES.map(([name, ticker]) => [name.split(" "), ticker] as const)

export type CompanyDirectory = {
  /** CIK → ticker (EDGAR). */
  byCik: Map<number, string>
  /** Ticker → the company's registered name. */
  names: Map<string, string>
  /** A company name → its ticker, or null. */
  resolve: (name: string) => string | null
}

/** Builds the directory from company_tickers.json rows (the first row per ticker and per name wins: the SEC lists the main share class first). */
export const buildDirectory = (rows: CompanyRow[]): CompanyDirectory => {
  const byCik = new Map<number, string>()
  const names = new Map<string, string>()
  const index = new Map<string, string>()
  const byFirst = new Map<string, string[]>()
  for (const r of rows) {
    const ticker = r.ticker.toUpperCase().replace(/-/g, ".")
    if (!byCik.has(r.cik)) byCik.set(r.cik, ticker)
    if (!names.has(ticker)) names.set(ticker, r.title)
    const key = normalizeName(r.title).join(" ")
    if (!key || index.has(key)) continue
    index.set(key, ticker)
    const first = key.split(" ")[0]
    const list = byFirst.get(first)
    if (list) list.push(key)
    else byFirst.set(first, [key])
  }
  const cache = new Map<string, string | null>()
  const lookup = (name: string): string | null => {
    const words = normalizeName(name)
    if (!words.length) return null
    for (const [alias, ticker] of ALIAS_WORDS) if (startsWith(words, [...alias])) return ticker
    // The longest leading run of the name that is a company's whole name…
    for (let k = words.length; k >= 1; k--) {
      if (k === 1 && !distinctive(words[0])) break
      const ticker = index.get(words.slice(0, k).join(" "))
      if (ticker) return ticker
    }
    // …or the name is the start of exactly one company's name.
    if (words.length < 2 && !distinctive(words[0])) return null
    const key = words.join(" ")
    const hits = new Set((byFirst.get(words[0]) ?? []).filter((k) => k.startsWith(`${key} `)).map((k) => index.get(k)))
    return hits.size === 1 ? ([...hits][0] ?? null) : null
  }
  return {
    byCik,
    names,
    resolve: (name) => {
      if (!cache.has(name)) {
        if (cache.size > 5_000) cache.clear()
        cache.set(name, lookup(name))
      }
      return cache.get(name) ?? null
    },
  }
}

let loaded: { dir: CompanyDirectory; at: number } | null = null

/** The SEC directory, loaded once a day and shared by every source (a failed reload keeps the last good one). */
export const companyDirectory = async (ctx: Pick<SourceContext, "fetch" | "now">): Promise<CompanyDirectory> => {
  if (loaded && ctx.now().getTime() - loaded.at < DAY_MS) return loaded.dir
  try {
    const body = await ctx.fetch.json<TickerFile>(SEC_TICKERS, { conditional: false, timeoutMs: 30_000 })
    const rows = Object.values(body ?? {}).map((r) => ({ cik: r.cik_str, ticker: r.ticker, title: r.title }))
    if (rows.length) loaded = { dir: buildDirectory(rows), at: ctx.now().getTime() }
  } catch (error) {
    if (!loaded) throw error
  }
  return loaded?.dir ?? buildDirectory([])
}

/** The directory when it can be had; otherwise the aliases alone, so a source that only names companies still runs. */
export const companyDirectoryOrAliases = (ctx: Pick<SourceContext, "fetch" | "now" | "log">) =>
  companyDirectory(ctx).catch((error) => {
    ctx.log.debug("SEC company directory unavailable; using aliases only", { error: String(error).slice(0, 200) })
    return buildDirectory([])
  })

/** For tests: forget the loaded directory. */
export const resetCompanyDirectory = () => {
  loaded = null
}
