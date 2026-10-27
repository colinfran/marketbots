import { load } from "cheerio"
import { marketTime } from "@mb/stock-core/time"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectoryOrAliases, normalizeName, shortName, type CompanyDirectory } from "./companies"
import { BROWSER_HEADERS, dayStart, isoDay, settleAll, watched } from "./common"

/**
 * FDA catalysts (`fda` and `clinicaltrials`), tier 1. Sponsors are named,
 * not ticked, so each is mapped to a ticker through the SEC company directory and its aliases
 * (sources/companies.ts); a sponsor that maps to no listed company is skipped.
 *
 *   fda:approvals      openFDA drugsfda (key): new NDA/BLA approvals (original applications) and
 *                      new indications (efficacy supplements) from the last 7 days. Generics
 *                      (ANDAs) and labeling, manufacturing or REMS supplements are left out.
 *                      openFDA lags the decision by days, so these confirm and document what the
 *                      FDA press feed (gov:fda) and the wires reported; they rarely break news.
 *   fda:adcomm         the FDA advisory-committee calendar (the JSON its page loads): meetings in
 *                      the next 7 days, with the sponsor read from the meeting page's agenda
 *                      ("…submitted by X", "…manufactured by X"), as calendar items.
 *   clinicaltrials     ClinicalTrials.gov API v2: trials led by a held or watched drug developer
 *                      that were suspended, terminated or withdrawn, or completed within 60 days,
 *                      updated in the last 7 days. A phase-3 halt weighs most.
 */

const DAY_MS = 86_400_000

// ── openFDA drug approvals ──────────────────────────────────────────────────

type Submission = { submission_type?: string; submission_number?: string; submission_status?: string; submission_status_date?: string; submission_class_code?: string; review_priority?: string }
type Product = { brand_name?: string; active_ingredients?: { name?: string }[] }
type Application = { application_number?: string; sponsor_name?: string; submissions?: Submission[]; products?: Product[]; openfda?: { brand_name?: string[]; generic_name?: string[] } }

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** Approvals in [from, to] (YYYYMMDD) that matter to a sponsor's stock, as items. */
export const approvalItems = (body: { results?: Application[] }, dir: CompanyDirectory, from: string, to: string): RawItem[] =>
  (body.results ?? []).flatMap((app) => {
    const number = app.application_number ?? ""
    const kind = /^BLA/.test(number) ? "BLA" : /^NDA/.test(number) ? "NDA" : null
    const ticker = app.sponsor_name ? dir.resolve(app.sponsor_name) : null
    if (!kind || !ticker) return []
    const brand = titleCase(app.openfda?.brand_name?.[0] ?? app.products?.[0]?.brand_name ?? number)
    const ingredient = (app.openfda?.generic_name?.[0] ?? app.products?.[0]?.active_ingredients?.[0]?.name ?? "").toLowerCase()
    const sponsor = titleCase(app.sponsor_name!)
    return (app.submissions ?? []).flatMap((s): RawItem[] => {
      const date = s.submission_status_date ?? ""
      const original = s.submission_type === "ORIG"
      if (s.submission_status !== "AP" || date < from || date > to || !(original || s.submission_class_code === "EFFICACY")) return []
      const day = isoDay(date)!
      const priority = s.review_priority === "PRIORITY" ? ", priority review" : ""
      return [
        {
          sourceId: `${number}:${s.submission_type}${s.submission_number ?? ""}`,
          title: original
            ? `${ticker}: FDA approves ${brand}${ingredient && ingredient !== brand.toLowerCase() ? ` (${ingredient})` : ""}, ${sponsor}'s new ${kind}${priority}`
            : `${ticker}: FDA approves a new indication for ${brand} (${sponsor}, efficacy supplement${priority})`,
          url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${number.replace(/\D/g, "")}`,
          publishedAt: dayStart(day),
          symbols: [ticker],
          category: "fda",
          kind: "filing",
          tier: 1,
          polarity: 1,
          // A new drug keeps the FDA base (75); a new indication for an approved one is less.
          ...(original ? {} : { baseSeverity: 55 }),
          meta: { application: number, submission: `${s.submission_type}${s.submission_number ?? ""}`, approved_on: day, sponsor: app.sponsor_name ?? null, review_priority: s.review_priority ?? null },
        },
      ]
    })
  })

const compact = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "")

// ── Advisory committees ─────────────────────────────────────────────────────

type AdcommRow = { field_start_date?: string; field_end_date?: string; title?: string; field_center?: string }
export type Meeting = { start: Date; title: string; path: string; center: string }

/** "10/30/2026 08:30 AM EDT" → the instant (New York time). */
export const fdaDateTime = (s: string | undefined): Date | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)/.exec((s ?? "").trim())
  if (!m) return null
  const h = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0)
  return marketTime(`${m[3]}-${m[1]}-${m[2]}`, `${String(h).padStart(2, "0")}:${m[5]}`)
}

/** Calendar rows → meetings starting within `days` (no tobacco or general-policy committees). */
export const upcomingMeetings = (rows: AdcommRow[], now: Date, days = 7): Meeting[] =>
  rows.flatMap((r) => {
    const start = fdaDateTime(r.field_start_date)
    const html = r.title ?? ""
    const path = /href="([^"]+)"/.exec(html)?.[1] ?? null
    const title = html.replace(/<[^>]+>/g, "").replace(/\s+-\s+\d{2}\/\d{2}\/\d{4}$/, "").trim()
    if (!start || !path || start.getTime() < now.getTime() - DAY_MS || start.getTime() > now.getTime() + days * DAY_MS) return []
    if (/tobacco|commissioner/i.test(r.field_center ?? "")) return []
    return [{ start, title, path, center: r.field_center ?? "" }]
  })

/** The applicant named in a meeting page's agenda, or null ("…submitted by Sydnexis. Inc.", "…manufactured by Moderna TX Inc., with…"). */
export const agendaSponsor = (html: string): string | null => {
  const $ = load(html)
  const text = $("body").text().replace(/\s+/g, " ")
  const agenda = text.slice(Math.max(0, text.search(/\bAgenda\b/)), Math.max(0, text.search(/\bAgenda\b/)) + 1_500)
  const m = /\b(?:submitted|manufactured|sponsored|developed) by ([A-Z][A-Za-z0-9.&,' -]{1,80}?)(?:,|\.\s|;|\s+(?:for|with|to|and is|which|in)\b)/.exec(agenda)
  return m ? m[1].trim().replace(/[.,]$/, "") : null
}

const ADCOMM_JSON = "https://www.fda.gov/datatables-json/advisory-committee-calendar-json"

export const adcommPoll = (ctx: SourceContext) => {
  /** Meeting page → sponsor (looked up once per day). */
  const sponsors = new Map<string, { sponsor: string | null; at: number }>()
  return async (): Promise<RawItem[] | null> => {
    const now = ctx.now()
    const rows = await ctx.fetch.json<AdcommRow[]>(ADCOMM_JSON, { headers: { ...BROWSER_HEADERS, accept: "application/json" } })
    if (rows === null) return null
    const meetings = upcomingMeetings(Array.isArray(rows) ? rows : [], now).slice(0, 8)
    const dir = await companyDirectoryOrAliases(ctx)
    const found = await settleAll(
      meetings.map((m) => async () => {
        const known = sponsors.get(m.path)
        if (known && now.getTime() - known.at < DAY_MS) return { m, sponsor: known.sponsor }
        const page = await ctx.fetch.get(`https://www.fda.gov${m.path}`, { headers: { ...BROWSER_HEADERS, accept: "text/html" }, conditional: false })
        const sponsor = agendaSponsor(page.text)
        sponsors.set(m.path, { sponsor, at: now.getTime() })
        return { m, sponsor }
      }),
    )
    return found.flatMap((x): RawItem[] => {
      const ticker = x?.sponsor ? dir.resolve(x.sponsor) : null
      if (!x || !ticker) return []
      return [
        {
          sourceId: `adcomm:${x.m.path}`,
          title: `Scheduled: FDA advisory committee on ${x.sponsor}'s application (${ticker}): ${x.m.title}`,
          url: `https://www.fda.gov${x.m.path}`,
          publishedAt: null,
          symbols: [ticker],
          category: "fda",
          kind: "calendar",
          tier: 1,
          polarity: 0,
          // A binary catalyst ahead, not news yet: enough to reach the dossier of a holder.
          baseSeverity: 25,
          meta: { event_at: x.m.start.toISOString(), sponsor: x.sponsor, center: x.m.center },
        },
      ]
    })
  }
}

// ── ClinicalTrials.gov ──────────────────────────────────────────────────────

type Study = {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string }
    statusModule?: { overallStatus?: string; whyStopped?: string; completionDateStruct?: { date?: string }; lastUpdatePostDateStruct?: { date?: string } }
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } }
    designModule?: { phases?: string[] }
  }
}

/** Names of drug developers (the SEC name) and the big pharma names that don't say so. */
const DRUG_DEVELOPER = /pharm|therapeut|bio(?!metric)|medicine|genetic|genomic|oncolog|vaccin|immun|clinical|life ?science/i
const BIG_PHARMA = new Set(["PFE", "MRK", "LLY", "ABBV", "BMY", "AMGN", "GILD", "JNJ", "AZN", "NVS", "GSK", "SNY", "NVO", "MRNA", "INCY", "REGN", "VRTX", "BNTX", "ARGX", "ALNY", "BIIB", "TAK"])
/** ClinicalTrials.gov matches whole words: the name a company's trials are registered under, when it isn't the SEC name. */
const TRIAL_SPONSOR: Record<string, string> = { MRNA: "ModernaTX", MRK: "Merck Sharp & Dohme", JNJ: "Janssen", LLY: "Eli Lilly", BMY: "Bristol-Myers Squibb", GSK: "GlaxoSmithKline", NVS: "Novartis" }
const STATUSES = ["SUSPENDED", "TERMINATED", "WITHDRAWN", "COMPLETED"]
const UPDATED_WITHIN_MS = 7 * DAY_MS
const COMPLETED_WITHIN_MS = 60 * DAY_MS
const MAX_COMPANIES = 15

const phaseLabel = (phases: string[] = []) => {
  const nums = phases.map((p) => /PHASE(\d)/.exec(p)?.[1]).filter(Boolean)
  return nums.length ? `phase ${nums.join("/")}` : "early-stage"
}

/** A sponsor's studies → items for the ones that changed status recently. */
export const trialItems = (body: { studies?: Study[] }, ticker: string, dir: CompanyDirectory, now: Date): RawItem[] =>
  (body.studies ?? []).flatMap((st): RawItem[] => {
    const p = st.protocolSection ?? {}
    const nct = p.identificationModule?.nctId
    const status = p.statusModule?.overallStatus ?? ""
    const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name ?? ""
    const updated = Date.parse(p.statusModule?.lastUpdatePostDateStruct?.date ?? "")
    const completion = Date.parse(p.statusModule?.completionDateStruct?.date ?? "")
    if (!nct || !STATUSES.includes(status) || dir.resolve(sponsor) !== ticker) return []
    if (!(now.getTime() - updated <= UPDATED_WITHIN_MS)) return []
    // An old trial whose record was only tidied up isn't news; a suspended trial's completion date is still ahead.
    if (Number.isFinite(completion) ? now.getTime() - completion > COMPLETED_WITHIN_MS : status === "COMPLETED") return []
    const phases = p.designModule?.phases ?? []
    const phase3 = phases.some((x) => /PHASE3|PHASE4/.test(x))
    const phase2 = phases.some((x) => /PHASE2/.test(x))
    const halted = status !== "COMPLETED"
    const why = p.statusModule?.whyStopped?.trim()
    return [
      {
        sourceId: `${nct}:${status}`,
        title: `${ticker}: ${phaseLabel(phases)} trial ${nct} ${status.toLowerCase()}${why ? ` (${why.slice(0, 120)})` : ""}: ${p.identificationModule?.briefTitle ?? ""}`,
        url: `https://clinicaltrials.gov/study/${nct}`,
        publishedAt: dayStart(new Date(updated).toISOString().slice(0, 10)),
        symbols: [ticker],
        category: "fda",
        kind: "news",
        tier: 1,
        polarity: halted ? -1 : 0,
        baseSeverity: halted ? (phase3 ? 60 : phase2 ? 45 : 30) : phase3 ? 30 : 20,
        meta: { nct, status, phases: phases.join(",") || null, sponsor, why_stopped: why ?? null },
      },
    ]
  })

const trialsUrl = (name: string, since: string) =>
  `https://clinicaltrials.gov/api/v2/studies?query.lead=${encodeURIComponent(name)}&filter.overallStatus=${STATUSES.join("|")}&filter.advanced=${encodeURIComponent(`AREA[LastUpdatePostDate]RANGE[${since},MAX]`)}&sort=LastUpdatePostDate:desc&pageSize=50&fields=NCTId,BriefTitle,OverallStatus,WhyStopped,CompletionDate,LastUpdatePostDate,LeadSponsorName,Phase`

export const isDrugDeveloper = (ticker: string, name: string) => BIG_PHARMA.has(ticker) || DRUG_DEVELOPER.test(name)

const trialsPoll = (ctx: SourceContext) => async (): Promise<RawItem[]> => {
  const now = ctx.now()
  const dir = await companyDirectoryOrAliases(ctx)
  const since = new Date(now.getTime() - UPDATED_WITHIN_MS).toISOString().slice(0, 10)
  const companies = [...watched(ctx)].flatMap((ticker) => {
    const name = dir.names.get(ticker)
    return name && isDrugDeveloper(ticker, name) && normalizeName(name).length ? [{ ticker, name: TRIAL_SPONSOR[ticker] ?? shortName(name) }] : []
  })
  const results = await settleAll(companies.slice(0, MAX_COMPANIES).map((c) => async () => trialItems((await ctx.fetch.json<{ studies?: Study[] }>(trialsUrl(c.name, since), { conditional: false })) ?? {}, c.ticker, dir, now)))
  return results.flatMap((r) => r ?? [])
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const FDA_SOURCES: SourceSpec[] = [
  {
    id: "fda:approvals",
    kind: "custom",
    url: "https://api.fda.gov/drug/drugsfda.json",
    // openFDA updates about weekly; four looks a day are plenty.
    interval_s: 21_600,
    tier: 1,
    wire_kind: "filing",
    key_env: "OPENFDA_API_KEY",
    default_enabled: true,
    note: "openFDA drugsfda (key): new NDA/BLA approvals and new indications in the last 7 days, sponsor mapped to a ticker",
    create: (spec, ctx) =>
      new PollingSource(spec, ctx, async () => {
        const now = ctx.now()
        const from = compact(new Date(now.getTime() - 7 * DAY_MS))
        const to = compact(now)
        const body = await ctx.fetch.json<{ results?: Application[] }>(`${spec.url}?api_key=${encodeURIComponent(ctx.env.OPENFDA_API_KEY ?? "")}&search=submissions.submission_status_date:[${from}+TO+${to}]&limit=100`, { conditional: false })
        return approvalItems(body ?? {}, await companyDirectoryOrAliases(ctx), from, to)
      }),
  },
  {
    id: "fda:adcomm",
    kind: "custom",
    url: ADCOMM_JSON,
    interval_s: 21_600,
    tier: 1,
    wire_kind: "calendar",
    default_enabled: true,
    note: "FDA advisory-committee calendar (the JSON behind the calendar page; browser User-Agent): meetings in the next 7 days whose applicant is a listed company",
    create: (spec, ctx) => new PollingSource(spec, ctx, adcommPoll(ctx)),
  },
  {
    id: "clinicaltrials",
    kind: "custom",
    url: "https://clinicaltrials.gov/api/v2/studies",
    interval_s: 21_600,
    tier: 1,
    default_enabled: true,
    note: "ClinicalTrials.gov API v2 (keyless): status changes on trials led by held or watched drug developers",
    create: (spec, ctx) => new PollingSource(spec, ctx, trialsPoll(ctx)),
  },
]
