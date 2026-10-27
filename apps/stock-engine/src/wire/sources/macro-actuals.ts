import { PollingSource } from "../poller"
import { MACRO_EVENTS, type MacroEvent } from "../calendar"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num } from "./common"

/**
 * The exact CPI and jobs numbers at release time (MASTER_PLAN §4.2 wave 2, `macro_actuals`; the
 * same logic as the crypto bot's). The item is market-wide; the market's reaction is the
 * `macro_reaction` rule's job (SPY's anomaly within 10 minutes of a release).
 *
 * Idle except in a release window: from a CPI or jobs release in wire/macro-calendar.json until
 * the new observation appears (giving up after 20 minutes), it polls the BLS API v2 every 30 s
 * (500 queries a day with the key; a release takes at most ~40). Then it emits one tier-1
 * `macro_release` item with the actuals and, when ForexFactory's calendar has them, the forecasts:
 *
 *   CPI   y/y from CUUR0000SA0 (the headline, not seasonally adjusted) and m/m from FRED's
 *         CPIAUCSL (seasonally adjusted, as forecasts are quoted)
 *   jobs  the payrolls change from CES0000000001 and the unemployment rate (LNS14000000)
 *
 * FRED (PAYEMS, UNRATE, CPIAUCSL) stands in when BLS fails. The calendar title names the
 * reference month ("CPI (October 2026)"), which is the observation to wait for.
 */

const WINDOW_MS = 20 * 60_000
const BLS = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
const FRED = "https://api.stlouisfed.org/fred/series/observations"
const FF = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

type ReleaseKind = "cpi" | "jobs"
export type RefMonth = { year: number; month: number }
/** One reported number, and the ForexFactory event its forecast is quoted on. */
export type Figure = { id: string; value: number; text: string; ff: RegExp }

const pad = (m: number) => String(m).padStart(2, "0")
const prevMonth = ({ year, month }: RefMonth): RefMonth => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 })

/** "CPI (October 2026)" → { year: 2026, month: 10 }. */
export const referenceMonth = (title: string): RefMonth | null => {
  const m = /\(([A-Z][a-z]+) (\d{4})\)/.exec(title)
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0
  return m && month ? { year: Number(m[2]), month } : null
}

const cpiYoY = (v: number, yearAgo: number): Figure => ({ id: "cpi_yoy", value: (v / yearAgo - 1) * 100, text: `${((v / yearAgo - 1) * 100).toFixed(1)}% y/y`, ff: /^CPI y\/y$/i })
const cpiMoM = (v: number, prev: number): Figure => ({ id: "cpi_mom", value: (v / prev - 1) * 100, text: `${((v / prev - 1) * 100).toFixed(1)}% m/m`, ff: /^CPI m\/m$/i })
const payrolls = (level: number, prev: number): Figure => ({ id: "payrolls", value: level - prev, text: `payrolls ${level - prev >= 0 ? "+" : ""}${Math.round(level - prev)}K`, ff: /^Non-Farm Employment Change$/i })
const unemployment = (rate: number): Figure => ({ id: "unemployment", value: rate, text: `unemployment ${rate.toFixed(1)}%`, ff: /^Unemployment Rate$/i })

// ── BLS ─────────────────────────────────────────────────────────────────────

const BLS_SERIES: Record<ReleaseKind, string[]> = { cpi: ["CUUR0000SA0"], jobs: ["CES0000000001", "LNS14000000"] }
type BlsResponse = { status?: string; message?: string[]; Results?: { series?: { seriesID: string; data?: { year: string; period: string; value: string }[] }[] } }

/** The release's figures from a BLS answer, or null while the reference month isn't out yet. */
export const blsFigures = (kind: ReleaseKind, body: BlsResponse, ref: RefMonth): Figure[] | null => {
  if (body.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS: ${body.status ?? "no status"} ${(body.message ?? []).join(" ").slice(0, 200)}`)
  const series = new Map((body.Results?.series ?? []).map((s) => [s.seriesID, s.data ?? []]))
  const value = (id: string, { year, month }: RefMonth) => num(series.get(id)?.find((d) => d.year === String(year) && d.period === `M${pad(month)}`)?.value)
  if (kind === "cpi") {
    const v = value("CUUR0000SA0", ref)
    const yearAgo = value("CUUR0000SA0", { year: ref.year - 1, month: ref.month })
    return v !== null && yearAgo ? [cpiYoY(v, yearAgo)] : null
  }
  const level = value("CES0000000001", ref)
  const prev = value("CES0000000001", prevMonth(ref))
  const rate = value("LNS14000000", ref)
  return level !== null && prev !== null && rate !== null ? [payrolls(level, prev), unemployment(rate)] : null
}

// ── FRED ────────────────────────────────────────────────────────────────────

type FredResponse = { observations?: { date: string; value: string }[] }

/** Newest-first observations → the reference month's value and the ones before it, or null when it isn't out yet. */
export const fredValues = (body: FredResponse, ref: RefMonth) => {
  const obs = body.observations ?? []
  if (obs[0]?.date !== `${ref.year}-${pad(ref.month)}-01`) return null
  return obs.map((o) => num(o.value))
}

const fredFigures = async (ctx: SourceContext, kind: ReleaseKind, ref: RefMonth): Promise<Figure[] | null> => {
  const series = async (id: string, limit: number) =>
    fredValues((await ctx.fetch.json<FredResponse>(`${FRED}?series_id=${id}&api_key=${encodeURIComponent(ctx.env.FRED_API_KEY ?? "")}&file_type=json&sort_order=desc&limit=${limit}`, { conditional: false })) ?? {}, ref)
  if (kind === "cpi") {
    const v = await series("CPIAUCSL", 2)
    return v && v[0] !== null && v[1] ? [cpiMoM(v[0], v[1])] : null
  }
  const [pay, rate] = await Promise.all([series("PAYEMS", 2), series("UNRATE", 1)])
  return pay && rate && pay[0] !== null && pay[1] !== null && rate[0] !== null ? [payrolls(pay[0], pay[1]), unemployment(rate[0])] : null
}

/** BLS first; FRED adds CPI m/m, or stands in when the BLS request fails. Null while the numbers aren't out. */
const readFigures = async (ctx: SourceContext, kind: ReleaseKind, ref: RefMonth): Promise<Figure[] | null> => {
  const hasFred = !!ctx.env.FRED_API_KEY
  let bls: Figure[] | null = null
  let blsError: unknown = null
  try {
    const body = await ctx.fetch.postJson<BlsResponse>(BLS, { seriesid: BLS_SERIES[kind], startyear: String(ref.year - 1), endyear: String(ref.year), registrationkey: ctx.env.BLS_API_KEY })
    bls = blsFigures(kind, body, ref)
  } catch (error) {
    blsError = error
  }
  if (bls) {
    const mom = kind === "cpi" && hasFred ? await fredFigures(ctx, kind, ref).catch(() => null) : null
    return [...(mom ?? []), ...bls]
  }
  // BLS answered and the month isn't there yet: keep waiting.
  if (!blsError) return null
  const fred = hasFred ? await fredFigures(ctx, kind, ref) : null
  if (fred) return fred
  throw blsError
}

// ── Forecasts and the item ──────────────────────────────────────────────────

type FfEvent = { title: string; country: string; date: string; forecast?: string }

/** ForexFactory's forecast for each figure (USD events within 10 minutes of the release). */
export const forecastsFor = (events: FfEvent[], release: Pick<MacroEvent, "at">, figures: Figure[]) => {
  const near = events.filter((e) => e.country === "USD" && Math.abs(Date.parse(e.date) - release.at.getTime()) <= 10 * 60_000)
  return new Map(figures.flatMap((f) => {
    const forecast = near.find((e) => f.ff.test(e.title.trim()))?.forecast?.trim()
    return forecast ? [[f.id, forecast] as const] : []
  }))
}

export const releaseItem = (release: Pick<MacroEvent, "kind" | "title" | "at">, ref: RefMonth, figures: Figure[], forecasts: Map<string, string>, now: Date): RawItem => {
  const meta: Record<string, string | number | null> = { release: release.kind, reference_month: `${ref.year}-${pad(ref.month)}`, scheduled_at: release.at.toISOString() }
  for (const f of figures) {
    const forecast = forecasts.get(f.id) ?? null
    const expected = forecast === null ? null : num(forecast.replace(/[%K,]/gi, ""))
    meta[f.id] = Math.round(f.value * 100) / 100
    meta[`${f.id}_forecast`] = forecast
    meta[`${f.id}_surprise`] = expected === null ? null : Math.round((f.value - expected) * 100) / 100
  }
  return {
    sourceId: `${release.kind}:${ref.year}-${pad(ref.month)}`,
    title: `${release.title}: ${figures.map((f) => `${f.text}${forecasts.has(f.id) ? ` (forecast ${forecasts.get(f.id)})` : ""}`).join(", ")}`,
    url: release.kind === "cpi" ? "https://www.bls.gov/news.release/cpi.nr0.htm" : "https://www.bls.gov/news.release/empsit.nr0.htm",
    publishedAt: now,
    symbols: [],
    marketWide: true,
    category: "macro_release",
    kind: "macro",
    tier: 1,
    polarity: 0,
    meta,
  }
}

const releaseKey = (e: MacroEvent) => `${e.kind}|${e.at.toISOString()}`

/** The CPI or jobs release whose window is open now and isn't done yet. */
export const openRelease = (now: Date, done: ReadonlySet<string>, events = MACRO_EVENTS) =>
  events.find((e) => (e.kind === "cpi" || e.kind === "jobs") && now.getTime() >= e.at.getTime() && now.getTime() - e.at.getTime() <= WINDOW_MS && !done.has(releaseKey(e))) ?? null

export const macroActualsPoll = (ctx: SourceContext, events = MACRO_EVENTS) => {
  const done = new Set<string>()
  let waiting: MacroEvent | null = null
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    const release = openRelease(now, done, events)
    if (waiting && waiting !== release) {
      ctx.log.info("macro actuals: no new observation within 20 minutes", { release: waiting.title })
      done.add(releaseKey(waiting))
    }
    waiting = release
    if (!release) return []
    const ref = referenceMonth(release.title)
    if (!ref) {
      done.add(releaseKey(release))
      return []
    }
    const figures = await readFigures(ctx, release.kind as ReleaseKind, ref)
    if (!figures) return []
    done.add(releaseKey(release))
    waiting = null
    const ff = await ctx.fetch.json<FfEvent[]>(FF, { conditional: false }).catch(() => null)
    return [releaseItem(release, ref, figures, forecastsFor(Array.isArray(ff) ? ff : [], release, figures), now)]
  }
}

export const MACRO_ACTUALS: SourceSpec = {
  id: "macro_actuals",
  kind: "custom",
  url: BLS,
  interval_s: 30,
  tier: 1,
  wire_kind: "macro",
  category_hint: "macro_release",
  key_env: "BLS_API_KEY",
  default_enabled: true,
  note: "BLS API v2 (key) and FRED (key) polled only in CPI and jobs release windows",
  create: (spec, ctx) => new PollingSource(spec, ctx, macroActualsPoll(ctx)),
}
