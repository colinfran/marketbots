import { XMLParser } from "fast-xml-parser"
import { marketTime } from "@mb/stock-core/time"
import { PollingSource } from "../poller"
import type { RawItem, SourceSpec } from "../types"

/**
 * Nasdaq Trader's trade-halt RSS: every halt and resumption across US exchanges, with the symbol,
 * the market, the reason code and the resumption times in `ndaq:` fields. A halt and its later
 * resumption are separate items, so a resumption can re-open a review.
 *
 * The feed also lists halts that have lasted for years; anything older than two days is not news
 * and is left out.
 */

const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => name === "item" })
const MAX_AGE_MS = 2 * 86_400_000

/** "10/26/2026" + "19:50:00.000" (New York time) → the instant, or null. */
const etInstant = (date: string, time: string): Date | null => {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date)
  const t = /^(\d{2}):(\d{2})/.exec(time)
  if (!d || !t) return null
  const at = marketTime(`${d[3]}-${d[1]}-${d[2]}`, `${t[1]}:${t[2]}`)
  return Number.isNaN(at.getTime()) ? null : at
}

/** Reason codes worth spelling out (the rest are shown as the code). */
const REASONS: Record<string, string> = {
  T1: "news pending",
  T2: "news released",
  T3: "news and resumption times",
  T5: "single-stock pause",
  T12: "additional information requested",
  H10: "SEC trading suspension",
  H11: "regulatory concern",
  M: "volatility pause",
  LUDP: "volatility pause",
  LUDS: "volatility pause (straddle)",
  MWC1: "market-wide circuit breaker level 1",
  MWC2: "market-wide circuit breaker level 2",
  MWC3: "market-wide circuit breaker level 3",
}

type HaltRow = Record<string, string | number | undefined>

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim())

export const parseHalts = (xml: string, now = new Date()): RawItem[] => {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: HaltRow[] } } }
  return (doc.rss?.channel?.item ?? []).slice(0, 200).flatMap((i): RawItem[] => {
    const symbol = str(i["ndaq:IssueSymbol"]).toUpperCase()
    if (!symbol) return []
    const code = str(i["ndaq:ReasonCode"])
    const resumes = str(i["ndaq:ResumptionTradeTime"])
    const when = `${str(i["ndaq:HaltDate"])} ${str(i["ndaq:HaltTime"])}`.trim()
    const haltedAt = etInstant(str(i["ndaq:HaltDate"]), str(i["ndaq:HaltTime"]))
    const resumesAt = resumes ? etInstant(str(i["ndaq:ResumptionDate"]) || str(i["ndaq:HaltDate"]), resumes) : null
    const at = resumesAt ?? haltedAt
    if (!at || now.getTime() - at.getTime() > MAX_AGE_MS) return []
    const reason = REASONS[code] ?? code
    const marketWide = code.startsWith("MWC")
    return [
      {
        sourceId: `${symbol}|${when}|${resumes}`,
        title: resumes
          ? `${symbol} resumes trading at ${resumes} ET (halted ${when}, ${reason})`
          : `${symbol} halted on ${str(i["ndaq:Market"])} at ${when} ET: ${reason}`,
        summary: str(i["ndaq:IssueName"]) || null,
        url: "https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts",
        // A resumption announced ahead of time is dated when it was seen, not in the future.
        publishedAt: at.getTime() > now.getTime() ? now : at,
        symbols: marketWide ? [] : [symbol],
        marketWide,
        category: "halt",
        kind: "venue",
        tier: 1,
        polarity: resumes ? 0 : -1,
        meta: { reason_code: code, halted_at: when, resumes_at: resumes || null },
      },
    ]
  })
}

export const haltsSpec: SourceSpec = {
  id: "halts",
  kind: "custom",
  url: "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",
  interval_s: 30,
  tier: 1,
  wire_kind: "venue",
  default_enabled: true,
  note: "Nasdaq Trader halts and resumptions",
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      const res = await ctx.fetch.get(spec.url!, { headers: { accept: "application/rss+xml" } })
      return res.notModified ? null : parseHalts(res.text)
    }),
}
