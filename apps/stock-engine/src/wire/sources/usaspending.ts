import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectoryOrAliases, type CompanyDirectory } from "./companies"
import { dayStart, isoDay, num, usd } from "./common"

/**
 * Large federal contracts (`usaspending`; USAspending.gov API, keyless):
 * new contract awards (types A–D) of $100M or more signed in the last 30 days, whose recipient maps
 * to a listed company (sources/companies.ts: the SEC directory plus subsidiaries such as Optum,
 * Raytheon, Sikorsky, Electric Boat). Tier 1, the company's own symbol.
 *
 * USAspending lags the signature by days, and the Defense Department's awards by about 90 days,
 * so these are context for the dossier (and a check on the wires), never fresh enough to trigger.
 */

const AWARDS = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
const MIN_USD = 100_000_000
const BIG_USD = 1_000_000_000

type Award = { "Award ID"?: string; "Recipient Name"?: string; "Award Amount"?: number; "Awarding Agency"?: string; "Base Obligation Date"?: string; Description?: string; generated_internal_id?: string }

export const awardQuery = (now: Date) => ({
  filters: {
    award_type_codes: ["A", "B", "C", "D"],
    time_period: [{ date_type: "date_signed", start_date: new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10), end_date: now.toISOString().slice(0, 10) }],
    award_amounts: [{ lower_bound: MIN_USD }],
  },
  fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Base Obligation Date", "Description", "generated_internal_id"],
  sort: "Base Obligation Date",
  order: "desc",
  limit: 100,
})

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

export const awardItems = (body: { results?: Award[] }, dir: CompanyDirectory): RawItem[] =>
  (body.results ?? []).flatMap((a): RawItem[] => {
    const recipient = a["Recipient Name"] ?? ""
    const amount = num(a["Award Amount"])
    const ticker = recipient ? dir.resolve(recipient) : null
    const signed = isoDay(a["Base Obligation Date"])
    if (!ticker || amount === null || amount < MIN_USD || !signed) return []
    const id = a.generated_internal_id ?? a["Award ID"] ?? `${recipient}:${signed}:${amount}`
    return [
      {
        sourceId: id,
        title: `${ticker}: ${a["Awarding Agency"] ?? "Federal"} contract to ${titleCase(recipient)} worth ${usd(amount)} (${a["Award ID"] ?? "award"}, signed ${signed})`,
        summary: a.Description ? titleCase(a.Description).slice(0, 400) : null,
        url: a.generated_internal_id ? `https://www.usaspending.gov/award/${encodeURIComponent(a.generated_internal_id)}` : "https://www.usaspending.gov/search",
        publishedAt: dayStart(signed),
        symbols: [ticker],
        category: "general",
        kind: "filing",
        tier: 1,
        polarity: 1,
        // Below an entry's threshold even for a watched name: the award is days to months old.
        baseSeverity: amount >= BIG_USD ? 45 : 35,
        meta: { award_id: a["Award ID"] ?? null, amount_usd: Math.round(amount), agency: a["Awarding Agency"] ?? null, recipient, signed },
      },
    ]
  })

export const USASPENDING_SOURCE: SourceSpec = {
  id: "usaspending",
  kind: "custom",
  url: AWARDS,
  interval_s: 3_600,
  tier: 1,
  wire_kind: "filing",
  default_enabled: true,
  note: "USAspending.gov award search (POST, keyless): new contracts ≥ $100M signed in the last 30 days, recipient mapped to a ticker",
  create: (spec, ctx: SourceContext) =>
    new PollingSource(spec, ctx, async () => {
      const body = await ctx.fetch.postJson<{ results?: Award[] }>(AWARDS, awardQuery(ctx.now()), { timeoutMs: 30_000 })
      return awardItems(body, await companyDirectoryOrAliases(ctx))
    }),
}
