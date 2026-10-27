"use client"

import type { EngineEvent, EventDataMap } from "@mb/crypto-core/events"
import { Excerpt, plural, Step as SharedStep, type StepStatus } from "@mb/ui/cycle-trail"
import { useNow } from "@mb/ui/live"
import { useStream } from "@mb/ui/stream"
import { DossierRows } from "@mb/ui/wire"
import { CheckIcon, ExternalLinkIcon, GlobeIcon, LoaderIcon, SearchIcon, XIcon, ZapIcon } from "lucide-react"
import Link from "next/link"
import { useMemo } from "react"
import { ActionBadge, StatusBadge, SymbolLink } from "@/components/bits"
import { STATE_LABEL } from "@/components/kit"
import { ago, duration, num, time, titleCase, usd } from "@/lib/format"

/**
 * The whole thinking process of one cycle, built from its events: the market scan and what it
 * flagged, every search query and source, the research memo as it's written, the model's
 * reasoning summaries (when the provider returns them), the AI decision as it's written, then
 * each decision with its risk check and what happened. Live on /live (follows the newest cycle).
 * Mirrors stockmarketbot's trail, with crypto's steps.
 */

type Data<T extends keyof EventDataMap> = EventDataMap[T]
const data = <T extends keyof EventDataMap>(e: EngineEvent | undefined) => e?.data as Data<T> | undefined

/** Crypto greys out skipped steps as well as pending ones. */
const Step = (props: React.ComponentProps<typeof SharedStep>) => <SharedStep muted={props.status === "pending" || props.status === "skipped"} {...props} />

type DecisionGroup = { proposed: Data<"ai.decision.proposed">; risk?: Data<"risk.checked">; at: string }

type Trail = {
  cycleId: string
  started?: Data<"cycle.started">
  startedAt?: string
  state?: Data<"cycle.state">
  screen?: Data<"screen.candidates">
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
  }
  decisions: DecisionGroup[]
  completed?: Data<"cycle.completed">
  failed?: Data<"cycle.failed">
  skipped?: Data<"cycle.skipped">
  finishedAt?: string
}

export const buildTrail = (cycleId: string, events: EngineEvent[]): Trail => {
  const t: Trail = { cycleId, research: { queries: [], sources: [] }, decision: {}, decisions: [] }
  const ordered = [...events].sort((a, b) => (a.seq && b.seq ? a.seq - b.seq : a.ts.localeCompare(b.ts)))
  for (const e of ordered) {
    switch (e.type) {
      case "cycle.started":
        t.started = data<"cycle.started">(e)
        t.startedAt = e.ts
        break
      case "cycle.state":
        t.state = data<"cycle.state">(e)
        break
      case "screen.candidates":
        t.screen = data<"screen.candidates">(e)
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
      case "ai.decision.proposed":
        t.decisions.push({ proposed: data<"ai.decision.proposed">(e)!, at: e.ts })
        break
      case "risk.checked": {
        const r = data<"risk.checked">(e)!
        const group = t.decisions.find((g) => g.proposed.decision_id === r.decision_id)
        if (group) group.risk = r
        break
      }
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

export function CycleTrailView({ trail, live }: { trail: Trail; live: boolean }) {
  const now = useNow(live ? 1_000 : 60_000)
  const finished = !!(trail.completed || trail.failed || trail.skipped)
  const running = live && !finished
  const r = trail.research
  const d = trail.decision
  // A completed cycle that never reached the AI: the screen found nothing to evaluate.
  const idle = !!trail.completed && !r.started && !d.started

  const scanStatus: StepStatus = trail.screen ? "done" : running ? "active" : trail.failed ? "failed" : finished ? "skipped" : "pending"
  const researchStatus: StepStatus = r.completed ? (r.completed.error ? "failed" : "done") : r.started ? (running ? "active" : "failed") : finished ? "skipped" : "pending"
  const decideStatus: StepStatus = d.failed ? "failed" : d.completed ? "done" : d.started ? (running ? "active" : "failed") : finished ? "skipped" : "pending"
  const executeStatus: StepStatus = trail.decisions.length ? (running ? "active" : "done") : d.completed && running ? "active" : finished ? "skipped" : "pending"
  const elapsed = trail.startedAt ? (trail.finishedAt ? Date.parse(trail.finishedAt) : now) - Date.parse(trail.startedAt) : null
  const screen = trail.screen
  const wire = trail.wire
  const wireStatus: StepStatus = wire ? "done" : r.started || d.started ? "skipped" : running && screen ? "active" : finished ? "skipped" : "pending"
  const event = trail.started?.trigger.startsWith("event:") ? trail.started.trigger.slice(6).trim() : null

  return (
    <div className="space-y-4">
      {event && (
        <p className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <ZapIcon className="size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Triggered by our news engine:</span> {event}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {running ? (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <span className="bg-gain size-2 animate-pulse rounded-full" aria-hidden />
            {STATE_LABEL[trail.state?.state ?? "idle"] ?? "Working"}
            {trail.state?.detail && <span className="text-muted-foreground font-normal">· {trail.state.detail}</span>}
          </span>
        ) : (
          <StatusBadge status={trail.completed ? "completed" : trail.failed ? "failed" : trail.skipped ? "skipped" : "running"} />
        )}
        {trail.started && <span className="text-muted-foreground text-xs">{trail.started.trigger}</span>}
        {trail.startedAt && (
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {time(trail.startedAt)} · {duration(elapsed)}
          </span>
        )}
      </div>

      <ol>
        <Step
          n={1}
          title="Scan the market"
          status={scanStatus}
          aside={screen ? [screen.symbols !== undefined && plural(screen.symbols, "symbol"), screen.regime && `${titleCase(screen.regime)} market`].filter(Boolean).join(" · ") || undefined : undefined}
        >
          {screen && (
            <>
              {screen.candidates.length > 0 ? (
                <ul className="space-y-1.5 text-xs">
                  {screen.candidates.map((c) => (
                    <li key={c.instrument} className="flex flex-wrap items-baseline gap-x-2">
                      <SymbolLink symbol={c.instrument} />
                      <span className="text-muted-foreground">
                        {titleCase(c.strategy)} · score {num(c.score, 0)}
                      </span>
                      <span className="text-muted-foreground basis-full">{c.signal}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No setups. None of the strategy screens flagged a coin{screen.reviews.length ? "" : ", and no open position is due for review"}.</p>
              )}
              {screen.reviews.length > 0 && <p className="text-muted-foreground text-xs">Positions to review: {screen.reviews.join(", ")}</p>}
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
                  <DossierRows rows={wire.rows.slice(5)} />
                </details>
              )}
            </>
          )}
        </Step>

        <Step
          n={3}
          title="Research the web and X"
          status={researchStatus}
          aside={r.started ? `${r.started.model}${r.completed ? ` · ${plural(r.queries.length, "search", "searches")} · ${plural(r.sources.length, "source")} · ${duration(r.completed.duration_ms)}` : ""}` : undefined}
        >
          {idle && <p className="text-muted-foreground text-xs">Skipped: the AI only runs when the scan finds a setup or a position needs review.</p>}
          {r.started && (
            <>
              {r.queries.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium">Searches ({r.queries.length})</p>
                  <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
                    {r.queries.map((q, i) => (
                      <li key={i} className="flex gap-1.5">
                        {q.tool === "x_search" ? (
                          <span className="text-muted-foreground w-3 shrink-0 text-center font-bold" aria-label="X search">
                            𝕏
                          </span>
                        ) : (
                          <SearchIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" aria-label="web search" />
                        )}
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
              {running && !r.completed && r.progress && <Excerpt icon={SearchIcon} label={`Writing the research memo (${r.progress.chars.toLocaleString("en-US")} chars)`} text={r.progress.excerpt} />}
              {r.completed?.error && <p className="text-loss text-xs">Research failed: {r.completed.error}. The decision used market data only.</p>}
            </>
          )}
        </Step>

        <Step
          n={4}
          title="Decide"
          status={decideStatus}
          aside={d.started ? `${d.started.model}${d.completed ? ` · ${plural(d.completed.decisions, "decision")}${d.completed.repaired ? " · repaired in code" : ""}` : ""}` : undefined}
        >
          {d.started && !d.completed && !d.failed && running && (
            <>
              <p className="text-muted-foreground text-xs">Weighing {d.started.items.join(", ")}</p>
              {d.reasoning && <Excerpt label={`Model reasoning (${d.reasoning.chars.toLocaleString("en-US")} chars)`} text={d.reasoning.excerpt} />}
              {d.progress && (
                <p className="text-muted-foreground text-xs">
                  Writing the decision ({d.progress.chars.toLocaleString("en-US")} chars){d.progress.headline ? `: “${d.progress.headline}”` : ""}
                  {d.progress.decisions ? ` · ${plural(d.progress.decisions, "decision")} so far` : ""}
                </p>
              )}
            </>
          )}
          {d.failed && <p className="text-loss text-xs">{d.failed.error}</p>}
          {d.completed && trail.completed?.summary && <p className="font-medium text-balance">{trail.completed.summary}</p>}
        </Step>

        <Step n={5} title="Risk checks & execution" status={executeStatus} aside={trail.decisions.length ? plural(trail.decisions.length, "decision") : undefined}>
          {trail.decisions.map((g) => {
            const p = g.proposed
            const executed = p.execution && p.execution !== "not_applicable" ? p.execution : null
            return (
              <div key={p.decision_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SymbolLink symbol={p.instrument} />
                  <ActionBadge action={p.action} />
                  <span className="text-muted-foreground text-xs">conviction {p.conviction}/100</span>
                  {p.edge_bps !== null && <span className="text-muted-foreground text-xs">net edge {num(p.edge_bps, 0)} bps</span>}
                  {executed ? <StatusBadge status={executed} /> : running && !g.risk && p.action === "buy" ? <LoaderIcon className="size-3.5 motion-safe:animate-spin" aria-label="working" /> : null}
                </div>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{p.thesis}</p>
                {g.risk && (
                  <div className="mt-2 text-xs">
                    {g.risk.approved ? (
                      <p className="flex gap-1.5">
                        <CheckIcon className="text-gain mt-0.5 size-3 shrink-0" aria-label="passed" />
                        <span>
                          Risk approved{g.risk.resized ? " (resized by exposure limits)" : ""}
                          {g.risk.qty !== null && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {g.risk.qty} {p.instrument.split("/")[0]}
                              {g.risk.notional_usd !== null && ` (${usd(g.risk.notional_usd)})`}
                            </span>
                          )}
                        </span>
                      </p>
                    ) : (
                      <ul className="space-y-0.5">
                        {g.risk.reasons.map((reason, i) => (
                          <li key={i} className="flex gap-1.5">
                            <XIcon className="text-loss mt-0.5 size-3 shrink-0" aria-label="failed" />
                            <span className="text-muted-foreground">{reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <Link href={`/decisions/${p.decision_id}`} className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-2">
                  Decision details
                </Link>
              </div>
            )
          })}
        </Step>
      </ol>

      {finished && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm">
          {trail.completed &&
            (idle ? (
              <span className="text-muted-foreground">No setups this cycle; the AI wasn&apos;t needed.</span>
            ) : (
              <>
                <span>
                  {plural(trail.completed.decisions, "decision")} · {trail.completed.approved} approved · {trail.completed.executed} executed
                </span>
                <span className="text-muted-foreground text-xs">${trail.completed.ai_cost_usd.toFixed(2)} of AI</span>
                {live && (
                  <Link href={`/research/${trail.cycleId}`} className="ml-auto inline-flex items-center gap-1 font-medium hover:underline">
                    Research & decisions <ExternalLinkIcon className="size-3.5" aria-hidden />
                  </Link>
                )}
              </>
            ))}
          {trail.failed && <span className="text-loss">Cycle failed: {trail.failed.error}</span>}
          {trail.skipped && <span className="text-muted-foreground">Skipped: {trail.skipped.reason}</span>}
          {trail.finishedAt && <span className="text-muted-foreground text-xs">{ago(trail.finishedAt, now)}</span>}
        </div>
      )}
    </div>
  )
}

type StoredCycle = { status: string; summary: string | null; error: string | null; finishedAt: string | null }

/**
 * The newest cycle, live: server-rendered events for it plus everything the stream adds. `stored`
 * is that cycle's record, which closes the trail when its end event is missing (cycles from
 * engines older than the idle-cycle completion event).
 */
export function LiveCycleTrail({ cycleId, initialEvents, stored }: { cycleId: string | null; initialEvents: EngineEvent[]; stored?: StoredCycle | null }) {
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
    const t = buildTrail(id, merged)
    if (id === cycleId && stored && stored.status !== "running" && !t.completed && !t.failed && !t.skipped) {
      const reason = stored.summary ?? stored.error ?? stored.status
      if (stored.status === "failed") t.failed = { cycle_id: id, error: stored.error ?? reason }
      else if (stored.status === "skipped") t.skipped = { reason }
      else t.completed = { cycle_id: id, duration_ms: 0, decisions: t.decisions.length, approved: 0, executed: 0, ai_cost_usd: 0, summary: reason }
      t.finishedAt = stored.finishedAt ?? undefined
    }
    return t
  }, [id, cycleId, initialEvents, events, stored])
  if (!trail) return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">No cycle has run yet. The next one starts on schedule, or from Admin.</p>
  return <CycleTrailView trail={trail} live />
}
