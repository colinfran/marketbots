import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { count, etNow, isMissing, median, previousWeekdays, watched } from "./common"

/**
 * Positioning (MASTER_PLAN §4.2 wave 2): context for the dossier, never a trigger.
 *
 *   cot          CFTC Traders in Financial Futures (Socrata, keyless): E-mini S&P 500, Nasdaq-100
 *                and VIX futures. One market-wide item per weekly report and market: leveraged
 *                funds' and asset managers' net positions and their change on the week.
 *   finra_short  FINRA's daily short-sale volume file (all off-exchange trade reporting
 *                facilities): a held or watched stock whose short share of FINRA-reported volume
 *                is ≥ 15 points above its own 10-day median and at least 55%, on 500K+ shares.
 *                Short volume includes market makers' hedging, so ~40–60% is normal and only the
 *                stock's own history says what is high. The first poll loads the last 10 days.
 */

// ── CFTC Commitments of Traders ─────────────────────────────────────────────

type CotRow = Record<string, string>

/** The full-size contracts (not the micro E-mini), as in the report's market names. */
const COT_MARKETS: { re: RegExp; id: string; label: string }[] = [
  { re: /^E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE$/, id: "ES", label: "E-mini S&P 500" },
  { re: /^NASDAQ-100 Consolidated - CHICAGO MERCANTILE EXCHANGE$/i, id: "NQ", label: "Nasdaq-100" },
  { re: /^VIX FUTURES - CBOE FUTURES EXCHANGE$/, id: "VX", label: "VIX futures" },
]
export const COT_WHERE = "market_and_exchange_names like '%E-MINI S&P 500%' OR market_and_exchange_names like '%NASDAQ-100 Consolidated%' OR market_and_exchange_names like '%VIX FUTURES%'"

const contracts = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}`

/** Latest report per market → one item each. */
export const cotItems = (rows: CotRow[]): RawItem[] =>
  COT_MARKETS.flatMap(({ re, id, label }) => {
    const latest = rows.filter((r) => re.test(r.market_and_exchange_names ?? "")).sort((a, b) => (b.report_date_as_yyyy_mm_dd ?? "").localeCompare(a.report_date_as_yyyy_mm_dd ?? ""))[0]
    if (!latest) return []
    const n = (k: string) => Number(latest[k] ?? 0)
    const date = (latest.report_date_as_yyyy_mm_dd ?? "").slice(0, 10)
    const lev = n("lev_money_positions_long") - n("lev_money_positions_short")
    const levChange = n("change_in_lev_money_long") - n("change_in_lev_money_short")
    const am = n("asset_mgr_positions_long") - n("asset_mgr_positions_short")
    const amChange = n("change_in_asset_mgr_long") - n("change_in_asset_mgr_short")
    return [
      {
        sourceId: `${date}:${id}`,
        title: `CFTC COT (${date}): ${label}, leveraged funds net ${contracts(lev)} contracts (${contracts(levChange)} on the week), asset managers net ${contracts(am)} (${contracts(amChange)})`,
        url: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
        symbols: [],
        marketWide: true,
        category: "general" as const,
        kind: "derivatives" as const,
        tier: 1 as const,
        polarity: 0 as const,
        // Weekly positioning: context, low enough that it never triggers anything.
        baseSeverity: 20,
        meta: { metric: `cot:${id}`, report_date: date, contract_units: latest.contract_units ?? null, open_interest: n("open_interest_all"), lev_net: lev, lev_net_change: levChange, asset_mgr_net: am, asset_mgr_net_change: amChange },
      },
    ]
  })

// ── FINRA daily short-sale volume ───────────────────────────────────────────

export type ShortDay = { day: string; rows: Map<string, { short: number; total: number }> }

/** Rows below this volume aren't kept in memory (the file lists ~12,000 symbols a day). */
const KEEP_MIN_VOLUME = 200_000
const MIN_VOLUME = 500_000
const MIN_RATIO = 0.55
const EXCESS = 0.15
const HISTORY_DAYS = 10
const MIN_HISTORY = 5

const fileUrl = (day: string) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${day.replace(/-/g, "")}.txt`

/** "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market" lines (a record-count trailer ends the file). */
export const parseShortVolume = (text: string, minVolume = KEEP_MIN_VOLUME): ShortDay | null => {
  const rows = new Map<string, { short: number; total: number }>()
  let day: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const [date, symbol, short, , total] = line.split("|")
    if (!symbol || !/^\d{8}$/.test(date)) continue
    const s = Number(short)
    const t = Number(total)
    if (!Number.isFinite(s) || !Number.isFinite(t) || t < minVolume) continue
    day ??= `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    rows.set(symbol.toUpperCase(), { short: s, total: t })
  }
  return day ? { day, rows } : null
}

/** The latest day against the days before it, for the given symbols. */
export const shortVolumeItems = (latest: ShortDay, history: ShortDay[], symbols: Iterable<string>): RawItem[] => {
  const prior = history.filter((h) => h.day < latest.day).slice(0, HISTORY_DAYS)
  const items: RawItem[] = []
  for (const symbol of symbols) {
    const row = latest.rows.get(symbol)
    if (!row || row.total < MIN_VOLUME) continue
    const ratios = prior.flatMap((h) => {
      const r = h.rows.get(symbol)
      return r && r.total > 0 ? [r.short / r.total] : []
    })
    if (ratios.length < MIN_HISTORY) continue
    const ratio = row.short / row.total
    const med = median(ratios)
    if (ratio < MIN_RATIO || ratio - med < EXCESS) continue
    items.push({
      sourceId: `${symbol}:${latest.day}`,
      title: `${symbol}: short volume ${(ratio * 100).toFixed(0)}% of FINRA-reported volume on ${latest.day} (10-day median ${(med * 100).toFixed(0)}%, ${count(row.total)} shares)`,
      url: "https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data/daily-short-sale-volume-files",
      publishedAt: null,
      symbols: [symbol],
      category: "general",
      kind: "derivatives",
      tier: 1,
      // Much of short volume is market makers' hedging: a pressure signal, not a direction.
      polarity: 0,
      baseSeverity: 25,
      meta: { metric: `finra_short:${symbol}`, day: latest.day, short_ratio: Math.round(ratio * 1000) / 1000, median_ratio: Math.round(med * 1000) / 1000, volume: Math.round(row.total), days: ratios.length },
    })
  }
  return items
}

/** FINRA posts the day's file around 18:00 ET. */
const PUBLISHED_AT_MIN = 18 * 60 + 15

export const finraPoll = (ctx: SourceContext) => {
  const days: ShortDay[] = []
  const load = async (day: string): Promise<ShortDay | null> => {
    try {
      return parseShortVolume((await ctx.fetch.get(fileUrl(day), { conditional: false, timeoutMs: 60_000 })).text)
    } catch (error) {
      // A holiday has no file (FINRA answers 403).
      if (isMissing(error)) return null
      throw error
    }
  }
  const keep = (d: ShortDay) => {
    if (days.some((x) => x.day === d.day)) return
    days.push(d)
    days.sort((a, b) => b.day.localeCompare(a.day))
    days.splice(HISTORY_DAYS + 1)
  }
  return async (): Promise<RawItem[]> => {
    const t = etNow(ctx.now())
    const weekday = t.weekday >= 1 && t.weekday <= 5
    const target = weekday && t.minutes >= PUBLISHED_AT_MIN ? t.day : previousWeekdays(t.day, 1)[0]
    if (days[0]?.day === target) return []
    if (!days.length) {
      // First poll: the history the latest day is compared with (stored, not reported).
      for (const day of previousWeekdays(target, HISTORY_DAYS)) {
        const d = await load(day)
        if (d) keep(d)
      }
    }
    const latest = await load(target)
    if (!latest) return []
    const items = shortVolumeItems(latest, days, watched(ctx))
    keep(latest)
    return items
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const POSITIONING_SOURCES: SourceSpec[] = [
  {
    id: "cot",
    kind: "json",
    url: `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$where=${encodeURIComponent(COT_WHERE)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=12`,
    // Weekly (Friday afternoon); hourly looks are cheap and catch it soon after.
    interval_s: 3_600,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "CFTC Traders in Financial Futures (Socrata, keyless): E-mini S&P 500, Nasdaq-100 and VIX futures; one item per report and market",
    map: (body) => cotItems(Array.isArray(body) ? (body as CotRow[]) : []),
  },
  {
    id: "finra_short",
    kind: "custom",
    url: "https://cdn.finra.org/equity/regsho/daily/",
    interval_s: 1_800,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "FINRA daily short-sale volume (keyless CDN, ~18:00 ET): held and watched stocks' short ratio far above their 10-day median",
    create: (spec, ctx) => new PollingSource(spec, ctx, finraPoll(ctx)),
  },
]
