import { PollingSource } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { etNow, num, settleAll, shortDay, signed } from "./common"

/**
 * EIA weekly energy reports (MASTER_PLAN §4.2 wave 2, `eia`; EIA API v2 with a free key):
 *
 *   crude   US crude inventories excluding the SPR (WCESTUS1), Weekly Petroleum Status Report,
 *           Wednesdays 10:30 ET
 *   natgas  Lower-48 working gas in storage (NW2_EPG0_SWO_R48_BCF), Thursdays 10:30 ET
 *
 * A first look at boot learns each report's latest week, so nothing old is reported as new. After
 * that it is idle except in a release window (10:29–12:30 ET on the release day and the day
 * after, which covers holiday weeks); in a window it polls every minute until a new week appears,
 * then emits one tier-1 market-wide item: the week's change, the prior week's change, and, when
 * ForexFactory's calendar has one, the forecast and the surprise. A large surprise (5M barrels or
 * 20 Bcf, or that far from the prior week's change when there's no forecast) gets a higher base.
 * Annotate only: the energy stocks' own moves are the anomaly detector's job.
 */

type Report = { id: "crude" | "natgas"; label: string; path: string; series: string; weekdays: number[]; unit: string; perUnit: number; big: number; ff: RegExp; url: string }

export const EIA_REPORTS: Report[] = [
  { id: "crude", label: "crude inventories", path: "petroleum/stoc/wstk", series: "WCESTUS1", weekdays: [3, 4], unit: "M barrels", perUnit: 1_000, big: 5, ff: /^Crude Oil Inventories$/i, url: "https://www.eia.gov/petroleum/supply/weekly/" },
  { id: "natgas", label: "natural gas storage", path: "natural-gas/stor/wkly", series: "NW2_EPG0_SWO_R48_BCF", weekdays: [3, 4, 5], unit: " Bcf", perUnit: 1, big: 20, ff: /^Natural Gas Storage$/i, url: "https://ir.eia.gov/ngs/ngs.html" },
]

const EIA = "https://api.eia.gov/v2"
const FF = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
const WINDOW_START = 10 * 60 + 29
const WINDOW_END = 12 * 60 + 30

type EiaBody = { response?: { data?: { period: string; value: string | number }[] } }
type FfEvent = { title: string; country: string; date: string; forecast?: string }

/** Newest-first weekly values in the report's unit (crude in million barrels, gas in Bcf). */
export const eiaValues = (body: EiaBody, r: Report) =>
  (body.response?.data ?? []).flatMap((d) => {
    const v = num(d.value)
    return v === null ? [] : [{ period: d.period, value: v / r.perUnit }]
  })

/** "-1.2M" → -1.2, "75B" → 75. */
const ffNumber = (s: string | undefined) => num((s ?? "").replace(/[MBK]$/i, ""))

export const eiaItem = (r: Report, values: { period: string; value: number }[], ff: FfEvent[], now: Date): RawItem | null => {
  const [last, prev, prev2] = values
  if (!last || !prev) return null
  const change = last.value - prev.value
  const prevChange = prev2 ? prev.value - prev2.value : null
  const event = ff.find((e) => e.country === "USD" && r.ff.test(e.title.trim()) && Math.abs(Date.parse(e.date) - now.getTime()) <= 2 * 86_400_000)
  const forecast = ffNumber(event?.forecast)
  const surprise = forecast === null ? null : change - forecast
  const big = surprise !== null ? Math.abs(surprise) >= r.big : prevChange !== null && Math.abs(change - prevChange) >= r.big
  const fmt = (n: number) => `${signed(n, 1)}${r.unit}`
  const level = r.id === "crude" ? `${last.value.toFixed(1)}M` : `${Math.round(last.value)} Bcf`
  const notes = [prevChange !== null ? `prior week ${fmt(prevChange)}` : null, surprise !== null ? `forecast ${fmt(forecast!)}, surprise ${fmt(surprise)}` : null].filter(Boolean)
  return {
    sourceId: `${r.id}:${last.period}`,
    title: `EIA ${r.label} ${fmt(change)} to ${level} in the week to ${shortDay(last.period)}${notes.length ? ` (${notes.join("; ")})` : ""}`,
    url: r.url,
    publishedAt: now,
    symbols: [],
    marketWide: true,
    category: "macro_release",
    kind: "macro",
    tier: 1,
    polarity: 0,
    baseSeverity: big ? 45 : 30,
    meta: {
      metric: `eia:${r.id}`,
      period: last.period,
      level: Math.round(last.value * 10) / 10,
      change: Math.round(change * 100) / 100,
      prior_change: prevChange === null ? null : Math.round(prevChange * 100) / 100,
      forecast,
      surprise: surprise === null ? null : Math.round(surprise * 100) / 100,
    },
  }
}

const inWindow = (r: Report, now: Date) => {
  const t = etNow(now)
  return r.weekdays.includes(t.weekday) && t.minutes >= WINDOW_START && t.minutes <= WINDOW_END
}

export const eiaPoll = (ctx: SourceContext, reports = EIA_REPORTS) => {
  /** The latest week seen per report (learned at boot), and the day each was last reported. */
  const latest = new Map<string, string>()
  const doneOn = new Map<string, string>()
  const read = async (r: Report) => {
    const url = `${EIA}/${r.path}/data/?api_key=${encodeURIComponent(ctx.env.EIA_API_KEY ?? "")}&frequency=weekly&data[0]=value&facets[series][]=${r.series}&sort[0][column]=period&sort[0][direction]=desc&length=3`
    return eiaValues((await ctx.fetch.json<EiaBody>(url, { conditional: false })) ?? {}, r)
  }
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    const today = etNow(now).day
    const due = reports.filter((r) => !latest.has(r.id) || (inWindow(r, now) && doneOn.get(r.id) !== today))
    if (!due.length) return []
    const results = await settleAll(due.map((r) => async () => ({ r, values: await read(r) })))
    const fresh = results.filter((x): x is NonNullable<typeof x> => !!x?.values.length && latest.get(x.r.id) !== x.values[0].period)
    const out: RawItem[] = []
    const ff = fresh.some((x) => latest.has(x.r.id)) ? await ctx.fetch.json<FfEvent[]>(FF, { conditional: false }).catch(() => null) : null
    for (const { r, values } of fresh) {
      const known = latest.has(r.id)
      latest.set(r.id, values[0].period)
      if (!known) continue
      doneOn.set(r.id, today)
      const item = eiaItem(r, values, Array.isArray(ff) ? ff : [], now)
      if (item) out.push(item)
    }
    return out
  }
}

export const EIA_SOURCE: SourceSpec = {
  id: "eia",
  kind: "custom",
  url: EIA,
  interval_s: 60,
  tier: 1,
  wire_kind: "macro",
  key_env: "EIA_API_KEY",
  default_enabled: true,
  note: "EIA API v2 (key): weekly crude inventories (Wed 10:30 ET) and natural gas storage (Thu 10:30 ET), polled only around the releases",
  create: (spec, ctx) => new PollingSource(spec, ctx, eiaPoll(ctx)),
}
