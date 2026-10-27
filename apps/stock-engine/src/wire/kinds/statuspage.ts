// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import type { PollFn } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"

/**
 * Atlassian Statuspage v2 (`/api/v2/summary.json`): unresolved incidents and maintenance that is
 * in progress or starts within a day. Each status change is a new item. Severity follows the
 * page's own impact rating, so routine "funding delayed for coin X" notices stay quiet while a
 * major outage or trading maintenance stands out.
 */

type Incident = { id: string; name: string; status: string; impact: string; updated_at: string; created_at: string; shortlink?: string; incident_updates?: { body: string }[] }
type Maintenance = { id: string; name: string; status: string; impact: string; scheduled_for: string; scheduled_until: string; shortlink?: string }
type Summary = { page?: { name?: string }; incidents?: Incident[]; scheduled_maintenances?: Maintenance[] }

const IMPACT_BASE: Record<string, number> = { none: 15, minor: 25, major: 60, critical: 75 }
/** Maintenance that stops trading matters; maintenance of one coin's deposits doesn't. */
const TRADING = /\b(order|trading|spot|matching|api|websocket|exchange|platform|login|futures)\b/i
const DAY_MS = 86_400_000

export const parseStatuspage = (body: Summary, label: string, now: Date): RawItem[] => {
  const page = body.page?.name ?? label
  const items: RawItem[] = []
  for (const i of body.incidents ?? []) {
    if (i.status === "resolved" || i.status === "postmortem") continue
    items.push({
      sourceId: `incident:${i.id}:${i.status}`,
      title: `${page}: ${i.name} (${i.status})`,
      summary: i.incident_updates?.[0]?.body ?? null,
      url: i.shortlink ?? null,
      publishedAt: new Date(i.updated_at ?? i.created_at),
      category: "venue_outage",
      kind: "venue",
      polarity: -1,
      marketWide: true,
      baseSeverity: IMPACT_BASE[i.impact] ?? 25,
      meta: { impact: i.impact, status: i.status },
    })
  }
  for (const m of body.scheduled_maintenances ?? []) {
    const starts = new Date(m.scheduled_for).getTime()
    const relevant = m.status === "in_progress" || (m.status === "scheduled" && starts - now.getTime() <= DAY_MS && starts >= now.getTime() - DAY_MS)
    if (!relevant) continue
    const trading = TRADING.test(m.name)
    items.push({
      sourceId: `maintenance:${m.id}:${m.status}`,
      title: `${page}: ${m.status === "in_progress" ? "maintenance in progress" : "maintenance scheduled"}: ${m.name} (${m.scheduled_for} to ${m.scheduled_until})`,
      url: m.shortlink ?? null,
      publishedAt: now,
      category: "venue_status",
      kind: "venue",
      polarity: -1,
      marketWide: true,
      baseSeverity: trading ? 45 : 15,
      meta: { status: m.status, starts_at: m.scheduled_for, ends_at: m.scheduled_until, trading },
    })
  }
  return items
}

export const statuspagePoller = (spec: SourceSpec, ctx: SourceContext): PollFn => async () => {
  const body = await ctx.fetch.json<Summary>(spec.url!)
  return body === null ? null : parseStatuspage(body, spec.id, ctx.now())
}
