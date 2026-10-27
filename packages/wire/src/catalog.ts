import { MACRO_ACTUALS } from "./sources/macro-actuals"
import type { RawItem, SourceSpec } from "./types"

/**
 * The catalog entries both bots define the same way (MASTER_PLAN §4.1 and §4.2): US government
 * and regulators (SEC, DOJ, OFAC, the Fed, the White House), Truth Social, the ForexFactory
 * calendar, the ECB, BoE and BoJ rate decisions and the BLS/FRED actuals. Each bot puts them where
 * it wants them in its own catalog (the order is part of its behavior) and passes the category
 * hint it wants for each government feed, since the two bots file the same feed differently (an
 * SEC trading suspension is a halt for stocks, regulatory action for crypto).
 *
 * Also `unixDate`, which both catalogs use for epoch-second dates.
 */

/** A plain RSS or Atom feed entry. */
const rss = <C extends string>(id: string, url: string, interval_s: number, tier: SourceSpec["tier"], extra: Partial<SourceSpec<C>> = {}): SourceSpec<C> => ({
  id,
  kind: "rss",
  url,
  interval_s,
  tier,
  default_enabled: true,
  ...extra,
})

/** Seconds since the epoch → a Date, or null. */
export const unixDate = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

/** Rate decisions and the policy statements around them; the feeds' statistics and speeches stay out. */
const CB_DECISION = /monetary policy (decisions?|statement|summary|report)|statement on monetary policy|key ecb interest rates|\bbank rate\b|guideline for (money )?market operations|outlook for economic activity and prices/i

/** ECB, BoE and BoJ feeds: decisions only, market-wide (they're macro, not about one coin or ticker). */
export const centralBankDecisions = (items: RawItem[]): RawItem<"macro_release">[] =>
  items.filter((i) => CB_DECISION.test(i.title)).map((i) => ({ ...i, symbols: [], marketWide: true, category: "macro_release" as const, kind: "macro" as const }))

const centralBank = (id: string, url: string) => rss<"macro_release">(id, url, 300, 1, { wire_kind: "macro", category_hint: "macro_release", refine: centralBankDecisions })

type DojRelease = { uuid: string; title: string; url: string; date: string; teaser?: string }
type FfEvent = { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string }

const MACRO_FF: SourceSpec<"macro_release"> = {
  id: "macro_ff",
  kind: "json",
  url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  interval_s: 300,
  tier: 3,
  wire_kind: "calendar",
  category_hint: "macro_release",
  default_enabled: true,
  note: "ForexFactory weekly calendar (unofficial): times and forecasts for high-impact USD events",
  map: (body) =>
    (Array.isArray(body) ? (body as FfEvent[]) : [])
      .filter((e) => e.country === "USD" && e.impact === "High")
      .map((e): RawItem<"macro_release"> => ({
        sourceId: `${e.title}|${e.date}`,
        title: `Scheduled: ${e.title} at ${e.date}${e.forecast ? ` (forecast ${e.forecast}, previous ${e.previous || "n/a"})` : ""}`,
        url: "https://www.forexfactory.com/calendar",
        publishedAt: null,
        category: "macro_release",
        kind: "calendar",
        marketWide: true,
        // Schedule information, not news: stored for the dossier, never loud.
        baseSeverity: 15,
        meta: { event_at: new Date(e.date).toISOString(), forecast: e.forecast || null, previous: e.previous || null },
      })),
}

/** The government feeds whose category hint each bot chooses (a feed without one leaves it to the lexicon). */
export type GovernmentFeed = "gov:sec_press" | "gov:sec_litigation" | "gov:sec_suspensions" | "gov:doj" | "gov:ofac" | "gov:fed" | "gov:whitehouse"

/** The shared entries by catalog id, with the bot's category hints. */
export const sharedCatalog = <C extends string>(hints: Partial<Record<GovernmentFeed, C>>) => {
  const hint = (id: GovernmentFeed): Partial<SourceSpec<C>> => (hints[id] ? { category_hint: hints[id] } : {})
  const doj: SourceSpec<C> = {
    id: "gov:doj",
    kind: "json",
    url: "https://www.justice.gov/api/v1/press_releases.json?pagesize=25&sort=date&direction=DESC",
    interval_s: 300,
    tier: 1,
    ...hint("gov:doj"),
    default_enabled: true,
    map: (body) => ((body as { results?: DojRelease[] }).results ?? []).map((r) => ({ sourceId: r.uuid, title: r.title, summary: r.teaser ?? null, url: r.url, publishedAt: unixDate(r.date) })),
  }
  return {
    // Government and regulators (tier 1). The SEC asks for a descriptive User-Agent.
    "gov:sec_press": rss<C>("gov:sec_press", "https://www.sec.gov/news/pressreleases.rss", 120, 1, { ...hint("gov:sec_press"), key_env: "SEC_USER_AGENT" }),
    "gov:sec_litigation": rss<C>("gov:sec_litigation", "https://www.sec.gov/enforcement-litigation/litigation-releases/rss", 300, 1, { ...hint("gov:sec_litigation"), key_env: "SEC_USER_AGENT" }),
    "gov:sec_suspensions": rss<C>("gov:sec_suspensions", "https://www.sec.gov/enforcement-litigation/trading-suspensions/rss", 300, 1, { ...hint("gov:sec_suspensions"), key_env: "SEC_USER_AGENT" }),
    "gov:doj": doj,
    "gov:ofac": rss<C>("gov:ofac", "https://ofac.treasury.gov/rss.xml", 300, 1, hint("gov:ofac")),
    "gov:fed": rss<C>("gov:fed", "https://www.federalreserve.gov/feeds/press_all.xml", 120, 1, hint("gov:fed")),
    "gov:whitehouse": rss<C>("gov:whitehouse", "https://www.whitehouse.gov/presidential-actions/feed/", 300, 1, hint("gov:whitehouse")),
    // Primary statements and calendars.
    truth_social: rss<C>("truth_social", "https://www.trumpstruth.org/feed", 60, 1, { note: "trumpstruth.org mirror of Truth Social; the posts are primary statements" }),
    macro_ff: MACRO_FF,
    // Central banks and macro numbers (tier 1).
    "cb:ecb": centralBank("cb:ecb", "https://www.ecb.europa.eu/rss/press.html"),
    "cb:boe": centralBank("cb:boe", "https://www.bankofengland.co.uk/rss/news"),
    "cb:boj": centralBank("cb:boj", "https://www.boj.or.jp/en/rss/whatsnew.xml"),
    macro_actuals: MACRO_ACTUALS,
  }
}
