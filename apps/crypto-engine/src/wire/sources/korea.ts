import type { RawItem, SourceContext, SourceSpec } from "../types"
import { universeBases } from "./common"

/**
 * Korean exchanges (`korea`), tier 1, from their official public APIs
 * (Upbit's website disallows crawling, so its notice pages are not read). Korean
 * retail moves fast and both exchanges flag unusual trading per coin; for our pairs that is
 * context, and an investment-warning designation or a delisting is a reason to review a holding.
 *
 *   korea:upbit            Open API market/all?is_details=true: the KRW market list with each
 *                          market's investment warning and caution flags, diffed poll to poll
 *   korea:bithumb          official notices: delistings, caution designations and liftings,
 *                          deposit/withdrawal pauses, new markets (promotions dropped)
 *   korea:bithumb_alerts   official per-market trading alerts (volume, deposits, concentration)
 *
 * Only pairs in the universe become items, and the adapters set the symbols themselves (Korean
 * titles carry the ticker in parentheses, "리플(XRP)"). A designation or a delisting is
 * `venue_status`, which reviews a holding; everything else is low-severity `general` context,
 * so a routine wallet maintenance never sets off a review.
 */

const DAY_MS = 86_400_000
const utcDay = (d: Date) => d.toISOString().slice(0, 10)
/** "2026-10-26 18:00:00" in Korea time (UTC+9) → the instant. */
const kst = (s: string | undefined): Date | null => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec((s ?? "").trim())
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}+09:00`)
  return Number.isNaN(d.getTime()) ? null : d
}
const words = (code: string) => code.toLowerCase().replace(/_/g, " ")

// ── Upbit ───────────────────────────────────────────────────────────────────

type UpbitMarket = { market: string; english_name?: string; market_event?: { warning?: boolean; caution?: Record<string, boolean> } }

const UPBIT_CAUTIONS: Record<string, string> = {
  PRICE_FLUCTUATIONS: "sharp price swings",
  TRADING_VOLUME_SOARING: "trading volume soaring",
  DEPOSIT_AMOUNT_SOARING: "deposits soaring",
  GLOBAL_PRICE_DIFFERENCES: "a price gap with global exchanges",
  CONCENTRATION_OF_SMALL_ACCOUNTS: "trading concentrated in a few accounts",
}

type UpbitState = { warning: boolean; cautions: string[]; name: string }

/** KRW markets → "warning|caution,caution|name", so the diff sees any flag change. */
export const upbitEntries = (body: unknown): Map<string, string> =>
  new Map(
    (Array.isArray(body) ? (body as UpbitMarket[]) : [])
      .filter((m) => typeof m.market === "string" && m.market.startsWith("KRW-"))
      .map((m) => {
        const cautions = Object.entries(m.market_event?.caution ?? {})
          .filter(([, on]) => on === true)
          .map(([k]) => k)
          .sort()
        return [m.market, `${m.market_event?.warning === true ? "W" : ""}|${cautions.join(",")}|${m.english_name ?? ""}`]
      }),
  )

const upbitState = (v: string | null): UpbitState => {
  const [w = "", c = "", name = ""] = (v ?? "").split("|")
  return { warning: w === "W", cautions: c ? c.split(",") : [], name }
}

export const upbitDescribe: NonNullable<SourceSpec["describe"]> = (change, ctx) => {
  const base = change.key.replace(/^KRW-/, "")
  const symbol = universeBases(ctx).get(base)
  if (!symbol || change.type === "added") return null
  const before = upbitState(change.before)
  const after = upbitState(change.after)
  const name = (after.name || before.name || base).trim()
  const day = utcDay(ctx.now())
  const url = `https://upbit.com/exchange?code=CRIX.UPBIT.${change.key}`
  const item = (what: string, title: string, rest: Pick<RawItem, "category" | "polarity" | "baseSeverity">): RawItem => ({
    sourceId: `${change.key}|${what}|${day}`,
    title,
    url,
    publishedAt: ctx.now(),
    symbols: [symbol],
    kind: "venue",
    ...rest,
    meta: { exchange: "upbit", market: change.key, change: what },
  })
  if (change.type === "removed") return item("removed", `Upbit removes ${name} (${base}) from its KRW market`, { category: "venue_status", polarity: -1, baseSeverity: 75 })
  if (after.warning && !before.warning) return item("warning", `Upbit designates ${name} (${base}) an investment warning`, { category: "venue_status", polarity: -1, baseSeverity: 60 })
  if (before.warning && !after.warning) return item("warning_lifted", `Upbit lifts the investment warning on ${name} (${base})`, { category: "general", polarity: 1, baseSeverity: 30 })
  const added = after.cautions.filter((c) => !before.cautions.includes(c))
  if (!added.length) return null
  return item(`caution:${added.join(",")}`, `Upbit flags ${name} (${base}) for ${added.map((c) => UPBIT_CAUTIONS[c] ?? words(c)).join(", ")}`, { category: "general", polarity: 0, baseSeverity: 25 })
}

// ── Bithumb ─────────────────────────────────────────────────────────────────

type BithumbNotice = { categories?: string[]; title?: string; pc_url?: string; published_at?: string }

const BITHUMB_LABELS: Record<string, string> = {
  점검: "maintenance",
  입출금: "deposits/withdrawals",
  안내: "notice",
  거래유의: "trading caution",
  "마켓 추가": "market added",
  거래지원종료: "delisting",
}
/** Promotions and airdrops: nothing to do with trading risk. */
const BITHUMB_SKIP = new Set(["이벤트", "수수료 이벤트"])
/** Tickers come in parentheses after the Korean name: "멀티버스엑스(EGLD), 페치(FET) …". */
const TICKERS = /\(([A-Z0-9]{2,12})\)/g

const classifyNotice = (categories: string[], title: string): Pick<RawItem, "category" | "polarity" | "baseSeverity"> => {
  if (categories.includes("거래지원종료")) return { category: "venue_status", polarity: -1, baseSeverity: 75 }
  // 지정 = designated (연장 = extended), 해제 = lifted.
  if (categories.includes("거래유의")) return /해제/.test(title) ? { category: "general", polarity: 1, baseSeverity: 30 } : { category: "venue_status", polarity: -1, baseSeverity: 60 }
  // "유의 촉구": the exchange urges caution on a coin.
  if (/유의 촉구/.test(title)) return { category: "general", polarity: -1, baseSeverity: 35 }
  if (categories.includes("입출금") || categories.includes("점검") || categories.includes("마켓 추가")) return { category: "general", polarity: 0, baseSeverity: 20 }
  return { category: "general", polarity: 0, baseSeverity: 15 }
}

export const bithumbNoticeItems = (body: unknown, ctx: Pick<SourceContext, "symbols">): RawItem[] => {
  const bases = universeBases(ctx)
  return (Array.isArray(body) ? (body as BithumbNotice[]) : []).flatMap((n): RawItem[] => {
    const title = (n.title ?? "").trim()
    const categories = n.categories ?? []
    if (!title || categories.some((c) => BITHUMB_SKIP.has(c))) return []
    const symbols = [...new Set([...title.matchAll(TICKERS)].map((m) => bases.get(m[1])).filter((s): s is string => !!s))]
    if (!symbols.length) return []
    const labels = categories.map((c) => BITHUMB_LABELS[c] ?? c).join(", ")
    return [
      {
        sourceId: n.pc_url ?? title,
        title: `Bithumb (${labels || "notice"}): ${title}`,
        url: n.pc_url ?? "https://feed.bithumb.com/notice",
        publishedAt: kst(n.published_at),
        symbols,
        kind: "venue",
        ...classifyNotice(categories, title),
        meta: { exchange: "bithumb", categories: categories.join(", ") || null },
      },
    ]
  })
}

type BithumbAlert = { market?: string; warning_type?: string; warning_step?: string; end_date?: string }

const ALERT_BASE: Record<string, number> = { DANGER: 35, WARNING: 30, CAUTION: 25 }

/** Per-market alerts; each (market, type, step, end) is one item, so a repeat poll is a duplicate. */
export const bithumbAlertItems = (body: unknown, ctx: Pick<SourceContext, "symbols" | "now">): RawItem[] => {
  const bases = universeBases(ctx)
  const now = ctx.now()
  return (Array.isArray(body) ? (body as BithumbAlert[]) : []).flatMap((a): RawItem[] => {
    const base = (a.market ?? "").replace(/^KRW-/, "")
    const symbol = a.market?.startsWith("KRW-") ? bases.get(base) : undefined
    if (!symbol || !a.warning_type) return []
    const step = (a.warning_step ?? "").toUpperCase()
    const end = kst(a.end_date)
    if (end && end.getTime() < now.getTime() - DAY_MS) return []
    return [
      {
        sourceId: `${a.market}|${a.warning_type}|${step}|${a.end_date ?? ""}`,
        title: `Bithumb alert on ${base}: ${words(a.warning_type)} (${step.toLowerCase() || "alert"}${a.end_date ? `, until ${a.end_date} KST` : ""})`,
        url: "https://www.bithumb.com/",
        publishedAt: now,
        symbols: [symbol],
        kind: "venue",
        category: "general",
        polarity: 0,
        baseSeverity: ALERT_BASE[step] ?? 25,
        meta: { exchange: "bithumb", market: a.market!, alert: a.warning_type, step: step || null },
      },
    ]
  })
}

export const KOREA_SOURCES: SourceSpec[] = [
  {
    id: "korea:upbit",
    kind: "diff",
    // The full market list is ~250 KB; warnings and cautions last hours to days, so every 5 min.
    url: "https://api.upbit.com/v1/market/all?is_details=true",
    interval_s: 300,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    note: "Upbit Open API (keyless): KRW markets with investment warnings and caution flags, diffed",
    entries: upbitEntries,
    describe: upbitDescribe,
  },
  {
    id: "korea:bithumb",
    kind: "json",
    url: "https://api.bithumb.com/v1/notices?count=20",
    interval_s: 60,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    note: "Bithumb public API (keyless, 1 request/s per IP): notices for universe coins; promotions dropped",
    map: bithumbNoticeItems,
  },
  {
    id: "korea:bithumb_alerts",
    kind: "json",
    url: "https://api.bithumb.com/v1/market/virtual_asset_warning",
    interval_s: 300,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    note: "Bithumb public API (keyless): per-market trading alerts for universe coins",
    map: bithumbAlertItems,
  },
]
