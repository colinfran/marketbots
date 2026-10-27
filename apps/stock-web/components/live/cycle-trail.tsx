"use client"

import type { EngineEvent, EventDataMap, RiskCheck } from "@mb/stock-core/events"
import { Excerpt, plural, Step, type StepStatus } from "@mb/ui/cycle-trail"
import { Badge } from "@mb/ui/components/badge"
import { useNow } from "@mb/ui/live"
import { useStream } from "@mb/ui/stream"
import { DossierRows } from "@mb/ui/wire"
import { CheckIcon, ExternalLinkIcon, GlobeIcon, LoaderIcon, SearchIcon, XIcon, ZapIcon } from "lucide-react"
import Link from "next/link"
import { useMemo } from "react"
import { ActionBadge, PhaseBadge, StatusBadge, SymbolLink } from "@/components/bits"
import { STATE_LABEL } from "@/components/kit"
import { ago, duration, time, titleCase } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The whole thinking process of one cycle, built from its events: what broker data was gathered,
 * what our news engine gave the AI, every search query and source, the research memo as it's
 * written, the model's reasoning summaries (when the provider returns them), the market read, then
 * each decision with every risk check and what happened. Live on /live (follows the newest cycle);
 * static on report pages. Event cycles open with what triggered them.
 */

type Data<T extends keyof EventDataMap> = EventDataMap[T]
const data = <T extends keyof EventDataMap>(e: EngineEvent | undefined) => e?.data as Data<T> | undefined

/** A news item behind an event cycle. */
export type TriggerItem = { id: string; title: string; url: string | null }

type DecisionGroup = { proposed: Data<"ai.decision.proposed">; risk?: Data<"risk.checked">; result?: Data<"decision.result">; at: string }

type Trail = {
  cycleId: string
  started?: Data<"cycle.started">
  startedAt?: string
  state?: Data<"cycle.state">
  context?: Data<"context.built">
  chains?: Data<"options.chains">
  /** What our news engine gave the AI. */
  wire?: Data<"wire.dossier">
  research: {
    started?: Data<"research.started">
    queries: { query: string; tool: string; at: string }[]
    sources: { title: string; url: string; domain: string }[]
    progress?: Data<"research.progress">
    reasoning?: Data<"ai.reasoning">
    completed?: Data<"research.completed">
  }
  decision: {
    started?: Data<"ai.decision.started">
    progress?: Data<"ai.decision.progress">
    reasoning?: Data<"ai.reasoning">
    completed?: Data<"ai.decision.completed">
    failed?: Data<"ai.decision.failed">
    report?: Data<"ai.report">
  }
  decisions: DecisionGroup[]
  steps: Data<"cycle.step">[]
  completed?: Data<"cycle.completed">
  failed?: Data<"cycle.failed">
  skipped?: Data<"cycle.skipped">
  finishedAt?: string
}

const buildTrail = (cycleId: string, events: EngineEvent[]): Trail => {
  const t: Trail = { cycleId, research: { queries: [], sources: [] }, decision: {}, decisions: [], steps: [] }
  const ordered = [...events].sort((a, b) => (a.seq && b.seq ? a.seq - b.seq : a.ts.localeCompare(b.ts)))
  for (const e of ordered) {
    const current = t.decisions.at(-1)
    switch (e.type) {
      case "cycle.started":
        t.started = data<"cycle.started">(e)
        t.startedAt = e.ts
        break
      case "cycle.state":
        t.state = data<"cycle.state">(e)
        break
      case "cycle.step":
        t.steps.push(data<"cycle.step">(e)!)
        break
      case "context.built":
        t.context = data<"context.built">(e)
        break
      case "options.chains":
        t.chains = data<"options.chains">(e)
        break
      case "wire.dossier":
        t.wire = data<"wire.dossier">(e)
        break
      case "research.started":
        t.research.started = data<"research.started">(e)
        break
      case "research.query":
        t.research.queries.push({ ...data<"research.query">(e)!, at: e.ts })
        break
      case "research.source": {
        const s = data<"research.source">(e)!
        if (!t.research.sources.some((x) => x.url === s.url)) t.research.sources.push(s)
        break
      }
      case "research.progress":
        t.research.progress = data<"research.progress">(e)
        break
      case "research.completed":
        t.research.completed = data<"research.completed">(e)
        break
      case "ai.reasoning": {
        const r = data<"ai.reasoning">(e)!
        if (r.task === "research") t.research.reasoning = r
        else t.decision.reasoning = r
        break
      }
      case "ai.decision.started":
        t.decision.started = data<"ai.decision.started">(e)
        break
      case "ai.decision.progress":
        t.decision.progress = data<"ai.decision.progress">(e)
        break
      case "ai.decision.completed":
        t.decision.completed = data<"ai.decision.completed">(e)
        break
      case "ai.decision.failed":
        t.decision.failed = data<"ai.decision.failed">(e)
        break
      case "ai.report":
        t.decision.report = data<"ai.report">(e)
        break
      case "ai.decision.proposed":
        t.decisions.push({ proposed: data<"ai.decision.proposed">(e)!, at: e.ts })
        break
      case "risk.checked":
        if (current && !current.risk) current.risk = data<"risk.checked">(e)
        break
      case "decision.result":
        if (current && !current.result) current.result = data<"decision.result">(e)
        break
      case "cycle.completed":
        t.completed = data<"cycle.completed">(e)
        t.finishedAt = e.ts
        break
      case "cycle.failed":
        t.failed = data<"cycle.failed">(e)
        t.finishedAt = e.ts
        break
      case "cycle.skipped":
        t.skipped = data<"cycle.skipped">(e)
        t.finishedAt = e.ts
        break
    }
  }
  return t
}

function Checks({ checks }: { checks: RiskCheck[] }) {
  return (
    <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
      {checks.map((c, i) => (
        <li key={i} className="flex gap-1.5">
          {c.ok ? <CheckIcon className="text-gain mt-0.5 size-3 shrink-0" aria-label="passed" /> : <XIcon className="text-loss mt-0.5 size-3 shrink-0" aria-label="failed" />}
          <span>
            <span className="font-medium">{c.name}</span> <span className="text-muted-foreground">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function CycleTrailView({ trail, live, triggerItems = [] }: { trail: Trail; live: boolean; triggerItems?: TriggerItem[] }) {
  const now = useNow(live ? 1_000 : 60_000)
  const finished = !!(trail.completed || trail.failed || trail.skipped)
  const running = live && !finished
  const r = trail.research
  const d = trail.decision
  const wire = trail.wire
  // The research step's log line says when Grok research was skipped (our feeds covered it) or only filled gaps.
  const researchNote = trail.steps.find((s) => s.name === "research" && s.ok)?.detail ?? null
  const researchSkipped = researchNote?.startsWith("skipped: ") ? researchNote.slice(9) : null
  const event = trail.started?.trigger.startsWith("event:") ? trail.started.trigger.slice(6).trim() : null

  const gatherStatus: StepStatus = trail.context ? "done" : trail.steps.some((s) => s.name === "context" && !s.ok) ? "failed" : running ? "active" : finished ? "skipped" : "pending"
  const wireStatus: StepStatus = wire ? "done" : r.started || d.started ? "skipped" : running && trail.context ? "active" : finished ? "skipped" : "pending"
  const researchStatus: StepStatus = r.completed ? (r.completed.error ? "failed" : "done") : r.started ? (running ? "active" : "failed") : researchSkipped || d.started || trail.skipped ? "skipped" : "pending"
  const decideStatus: StepStatus = d.failed ? "failed" : d.completed ? "done" : d.started ? (running ? "active" : "failed") : trail.skipped ? "skipped" : "pending"
  const executeStatus: StepStatus = trail.completed ? "done" : trail.decisions.length ? (running ? "active" : trail.failed ? "failed" : "done") : d.completed && running ? "active" : trail.failed || trail.skipped ? "skipped" : "pending"
  const elapsed = trail.startedAt ? (trail.finishedAt ? Date.parse(trail.finishedAt) : now) - Date.parse(trail.startedAt) : null

  return (
    <div className="space-y-4">
      {event && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <ZapIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-0.5">
            <p>
              <span className="font-medium">Triggered by our news engine:</span> {event}
            </p>
            {triggerItems.map((i) => (
              <p key={i.id} className="text-muted-foreground text-xs">
                {i.url ? (
                  <a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground hover:underline">
                    {i.title}
                  </a>
                ) : (
                  i.title
                )}
              </p>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {trail.started && <PhaseBadge phase={trail.started.phase} />}
        {running ? (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <span className="bg-gain size-2 animate-pulse rounded-full" aria-hidden />
            {STATE_LABEL[trail.state?.state ?? "idle"] ?? "Working"}
            {trail.state?.detail && <span className="text-muted-foreground font-normal">· {trail.state.detail}</span>}
          </span>
        ) : (
          <StatusBadge status={trail.completed ? "succeeded" : trail.failed ? "failed" : trail.skipped ? "skipped" : "running"} />
        )}
        {trail.started && <span className="text-muted-foreground text-xs">{trail.started.trigger}</span>}
        {trail.startedAt && (
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {time(trail.startedAt)} · {duration(elapsed)}
          </span>
        )}
      </div>

      <ol>
        <Step n={1} title="Gather broker data" status={gatherStatus} aside={trail.context ? `${plural(trail.context.positions, "stock")} · ${plural(trail.context.option_positions, "options position")} · ${plural(trail.context.headlines, "headline")}` : undefined}>
          {trail.context && (
            <>
              <p className="text-muted-foreground">
                Equity ${trail.context.equity.toLocaleString("en-US")}, day {trail.context.day_pnl_pct >= 0 ? "+" : ""}
                {trail.context.day_pnl_pct}%, {plural(trail.context.instruments, "instrument")} with live quotes and technicals. New buys {trail.context.new_buys_allowed ? "allowed" : "blocked"}.
              </p>
              {trail.context.flags.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-300">
                  {trail.context.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              {trail.chains && (
                <p className="text-muted-foreground text-xs">
                  Option chains: {trail.chains.underlyings.map((u) => `${u.symbol} (${plural(u.contracts, "liquid contract")})`).join(", ")}
                </p>
              )}
            </>
          )}
        </Step>

        <Step n={2} title="Our research" status={wireStatus} aside={wire ? `${plural(wire.total, "item")} from our feeds` : undefined}>
          {wire && wire.rows.length === 0 && <p className="text-muted-foreground text-xs">Our news engine had nothing on these subjects.</p>}
          {wire && wire.rows.length > 0 && (
            <>
              <DossierRows rows={wire.rows.slice(0, 5)} />
              {wire.rows.length > 5 && (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer">Show all {wire.rows.length}</summary>
                  <div className="mt-1">
                    <DossierRows rows={wire.rows.slice(5)} />
                  </div>
                </details>
              )}
            </>
          )}
        </Step>

        <Step
          n={3}
          title="Research the web and X"
          status={researchStatus}
          aside={
            r.started
              ? `${researchNote?.startsWith("gap-fill") ? "gap-fill · " : ""}${r.started.model}${r.completed ? ` · ${plural(r.queries.length, "search", "searches")} · ${plural(r.sources.length, "source")} · ${duration(r.completed.duration_ms)}` : ""}`
              : undefined
          }
        >
          {researchSkipped && <p className="text-muted-foreground text-xs">Grok research was skipped: {researchSkipped}. The decision used our own feeds.</p>}
          {r.started && (
            <>
              {r.queries.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium">Searches ({r.queries.length})</p>
                  <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
                    {r.queries.map((q, i) => (
                      <li key={i} className="flex gap-1.5">
                        {q.tool === "x_search" ? <span className="text-muted-foreground w-3 shrink-0 text-center font-bold" aria-label="X search">𝕏</span> : <SearchIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" aria-label="web search" />}
                        <span>{q.query}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.sources.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium">Sources read ({r.sources.length})</p>
                  <ul className="grid max-h-48 gap-0.5 overflow-y-auto text-xs sm:grid-cols-2">
                    {r.sources.map((s) => (
                      <li key={s.url} className="min-w-0">
                        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-muted-foreground hover:text-foreground flex items-center gap-1.5">
                          <GlobeIcon className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{s.title || s.domain}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {running && !r.completed && r.reasoning && <Excerpt label={`Model reasoning (${r.reasoning.chars.toLocaleString("en-US")} chars)`} text={r.reasoning.excerpt} />}
              {running && !r.completed && r.progress && <Excerpt label={`Writing the research memo (${r.progress.chars.toLocaleString("en-US")} chars)`} text={r.progress.excerpt} icon={SearchIcon} />}
              {r.completed?.error && <p className="text-loss text-xs">Research failed: {r.completed.error}. The decision used broker data only.</p>}
            </>
          )}
        </Step>

        <Step n={4} title="Decide" status={decideStatus} aside={d.started ? `${d.started.model}${d.completed ? ` · ${plural(d.completed.decisions, "decision")}${d.completed.repaired ? " · repaired in code" : ""}` : ""}` : undefined}>
          {d.started && !d.report && running && (
            <>
              {d.reasoning && <Excerpt label={`Model reasoning (${d.reasoning.chars.toLocaleString("en-US")} chars)`} text={d.reasoning.excerpt} />}
              {d.progress && (
                <p className="text-muted-foreground text-xs">
                  Writing the decision ({d.progress.chars.toLocaleString("en-US")} chars){d.progress.headline ? `: “${d.progress.headline}”` : ""}
                  {d.progress.decisions ? ` · ${d.progress.decisions} decisions so far` : ""}
                </p>
              )}
            </>
          )}
          {d.failed && <p className="text-loss text-xs">{d.failed.error}</p>}
          {d.report && (
            <div className="space-y-2">
              <p className="font-medium text-balance">{d.report.headline}</p>
              <p className="text-muted-foreground leading-relaxed">{d.report.summary}</p>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="secondary">{titleCase(d.report.sentiment)}</Badge>
                <Badge variant="secondary">{titleCase(d.report.regime)}</Badge>
                <Badge variant="secondary">Stance: {titleCase(d.report.stance)}</Badge>
                <Badge variant="secondary">Confidence {d.report.confidence}%</Badge>
              </div>
              {d.report.key_drivers.length > 0 && (
                <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
                  {d.report.key_drivers.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              )}
              {d.report.watchlist.length > 0 && <p className="text-muted-foreground text-xs">Watchlist: {d.report.watchlist.join(", ")}</p>}
            </div>
          )}
        </Step>

        <Step n={5} title="Risk checks & execution" status={executeStatus} aside={trail.decisions.length ? plural(trail.decisions.length, "decision") : undefined}>
          {trail.decisions.length === 0 && d.report && !running && <p className="text-muted-foreground text-xs">No decisions this cycle.</p>}
          {trail.decisions.map((g, i) => (
            <div key={i} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <SymbolLink symbol={g.proposed.symbol} />
                <ActionBadge action={g.proposed.action} />
                <span className="text-muted-foreground text-xs">conviction {g.proposed.conviction}/10</span>
                {g.result ? <StatusBadge status={g.result.status} /> : running ? <LoaderIcon className="size-3.5 motion-safe:animate-spin" aria-label="working" /> : null}
              </div>
              {g.proposed.detail && <p className="mt-1 font-mono text-xs">{g.proposed.detail}</p>}
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{g.proposed.rationale}</p>
              {g.risk && g.risk.checks.length > 0 && (
                <div className="mt-2">
                  <Checks checks={g.risk.checks} />
                </div>
              )}
              {/* The rejection reason is already the failed check above; show it only when it adds something. */}
              {g.result?.reason && !g.risk?.checks.some((c) => !c.ok && c.detail === g.result!.reason) && (
                <p className={cn("mt-2 text-xs", g.result.status === "failed" || g.result.status === "rejected" ? "text-loss" : "text-muted-foreground")}>{g.result.reason}</p>
              )}
            </div>
          ))}
        </Step>
      </ol>

      {(trail.completed || trail.failed || trail.skipped) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm">
          {trail.completed && (
            <>
              <span>
                {trail.completed.executed} executed · {trail.completed.rejected} rejected{trail.completed.failed ? ` · ${trail.completed.failed} failed` : ""}
              </span>
              <span className="text-muted-foreground text-xs">${trail.completed.ai_cost_usd.toFixed(2)} of AI</span>
              {live && (
                <Link href={`/research/${trail.completed.report_id}`} className="ml-auto inline-flex items-center gap-1 font-medium hover:underline">
                  Full report <ExternalLinkIcon className="size-3.5" aria-hidden />
                </Link>
              )}
            </>
          )}
          {trail.failed && <span className="text-loss">Cycle failed: {trail.failed.error}</span>}
          {trail.skipped && <span className="text-muted-foreground">Skipped: {trail.skipped.reason}</span>}
          {trail.finishedAt && <span className="text-muted-foreground text-xs">{ago(trail.finishedAt, now)}</span>}
        </div>
      )}
    </div>
  )
}

/** A stored cycle (report pages). */
export function CycleTrail({ cycleId, events, triggerItems }: { cycleId: string; events: EngineEvent[]; triggerItems?: TriggerItem[] }) {
  const trail = useMemo(() => buildTrail(cycleId, events), [cycleId, events])
  return <CycleTrailView trail={trail} live={false} triggerItems={triggerItems} />
}

/**
 * The items behind an event cycle that started after the page loaded, from the stream: the
 * triggers that fired or queued shortly before it (and match its "rule SYMBOL" label), and the
 * titles of their items. Queued triggers expire after 30 minutes, so nothing older counts.
 */
const streamTriggerItems = (events: EngineEvent[], trail: Trail): TriggerItem[] => {
  const label = trail.started?.trigger.startsWith("event:") ? trail.started.trigger : null
  if (!label || !trail.startedAt) return []
  const start = Date.parse(trail.startedAt)
  const titles = new Map<string, TriggerItem>()
  const ids = new Set<string>()
  for (const e of events) {
    if (e.type === "wire.item") {
      const i = data<"wire.item">(e)!
      titles.set(i.id, { id: i.id, title: i.title, url: i.url })
    } else if (e.type === "wire.notable") {
      const i = data<"wire.notable">(e)!
      if (!titles.has(i.id)) titles.set(i.id, { id: i.id, title: i.title, url: null })
    } else if (e.type === "wire.trigger") {
      const t = data<"wire.trigger">(e)!
      const age = start - Date.parse(e.ts)
      const rule = t.rule.replace(/_/g, " ")
      const matches = (t.symbols.length ? t.symbols.map((s) => `${rule} ${s}`) : [`${rule} market`]).some((k) => label.includes(k))
      if ((t.status === "fired" || t.status === "queued") && age >= 0 && age <= 31 * 60_000 && matches) t.item_ids.forEach((id) => ids.add(id))
    }
  }
  return [...ids].flatMap((id) => titles.get(id) ?? [])
}

/** The newest cycle, live: server-rendered events for it plus everything the stream adds. */
export function LiveCycleTrail({ cycleId, initialEvents, triggerItems = [] }: { cycleId: string | null; initialEvents: EngineEvent[]; triggerItems?: TriggerItem[] }) {
  const { events } = useStream<EngineEvent>()
  const latestStart = events.find((e) => e.type === "cycle.started")
  // Follow a cycle that started after the page loaded.
  const id = latestStart?.cycle_id && (!cycleId || Date.parse(latestStart.ts) >= Date.parse(initialEvents.find((e) => e.type === "cycle.started")?.ts ?? "0")) ? latestStart.cycle_id : cycleId
  const trail = useMemo(() => {
    if (!id) return null
    const seen = new Set<string>()
    const merged = [...(id === cycleId ? initialEvents : []), ...events.filter((e) => e.cycle_id === id)].filter((e) => {
      const key = e.seq ? String(e.seq) : `${e.type}|${e.ts}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return buildTrail(id, merged)
  }, [id, cycleId, initialEvents, events])
  // The server knows the items behind the cycle it rendered; for one that started since, read them off the stream.
  const items = useMemo(() => (!trail ? [] : id === cycleId && triggerItems.length ? triggerItems : streamTriggerItems(events, trail)), [trail, id, cycleId, triggerItems, events])
  if (!trail) return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">No cycle has run yet. The next one starts on schedule, or from Admin.</p>
  return <CycleTrailView trail={trail} live triggerItems={items} />
}
