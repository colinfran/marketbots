import data from "./macro-calendar.json"

/**
 * Scheduled US macro releases (FOMC decisions, CPI, jobs, PPI, PCE, GDP) from the official
 * schedules, in UTC. They feed the dossier ("what's coming in the next 72 hours") and the
 * macro-reaction rule ("a release just came out and the market jumped"). The file is regenerated
 * from federalreserve.gov, bls.gov and bea.gov; `coverageGaps` warns 30 days before any kind runs
 * out of dates.
 */

export type MacroKind = "fomc" | "cpi" | "jobs" | "ppi" | "pce" | "gdp"
export type MacroEvent = { kind: MacroKind; title: string; at: Date; source: string }

export const MACRO_EVENTS: MacroEvent[] = (data.events as { kind: string; title: string; at: string; source: string }[])
  .map((e) => ({ kind: e.kind as MacroKind, title: e.title, at: new Date(e.at), source: e.source }))
  .sort((a, b) => a.at.getTime() - b.at.getTime())

/** Releases in the next `hours`. */
export const upcomingMacro = (now: Date, hours = 72, events = MACRO_EVENTS) => events.filter((e) => e.at.getTime() >= now.getTime() && e.at.getTime() <= now.getTime() + hours * 3_600_000)

/** Releases in the last `minutes` (for "the market reacted to it"). */
export const recentMacro = (now: Date, minutes: number, events = MACRO_EVENTS) => events.filter((e) => e.at.getTime() <= now.getTime() && e.at.getTime() >= now.getTime() - minutes * 60_000)

/** Kinds whose last known date is within `days`: the calendar file needs regenerating. */
export const coverageGaps = (now: Date, days = 30, events = MACRO_EVENTS): string[] => {
  const last = new Map<MacroKind, Date>()
  for (const e of events) last.set(e.kind, e.at)
  return [...last].filter(([, at]) => at.getTime() < now.getTime() + days * 86_400_000).map(([kind, at]) => `${kind} dates end ${at.toISOString().slice(0, 10)}`)
}
