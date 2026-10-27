import type { CycleDoc, ReportDoc } from "@mb/stock-core/db"
import type { EngineEvent } from "@mb/stock-core/events"
import { formatDateTime, formatTime } from "@mb/stock-core/time"
import { CheckCircle2Icon, ExternalLinkIcon, XCircleIcon, ZapIcon } from "lucide-react"
import { CycleTrail } from "@/components/live/cycle-trail"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DossierRows, WireItemRow } from "@/components/wire"
import { price, titleCase, usd } from "@/lib/format"
import type { DecisionRow, WireCycleContext } from "@/lib/queries"
import { CycleKindBadge, Delta, PhaseBadge, ResearchModeBadge, StatusBadge, SymbolLink } from "./bits"
import { DecisionsTable } from "./tables"

const SEVERITY: Record<string, string> = {
  low: "border-transparent bg-slate-500/15",
  medium: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  high: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * One cycle's report. The two kinds of research stay separate: AI research (Grok's memo, its
 * searches and sources) and our research (what the news engine gave the AI, and for event cycles
 * the trigger and items that started the cycle).
 */
export function ReportView({ doc, decisions, cycle, events, wire }: { doc: ReportDoc; decisions: DecisionRow[]; cycle: CycleDoc | null; events: EngineEvent[]; wire?: WireCycleContext | null }) {
  const r = doc.report
  const account = doc.context?.risk
  const sources = [
    ...new Map(
      [...r.sources, ...doc.research.sources.map((s) => ({ title: s.title ?? host(s.url), url: s.url }))].map((s) => [s.url, s]),
    ).values(),
  ]
  const mode = doc.research.mode
  const dossier = doc.research.dossier ?? []
  const triggeredBy = cycle?.kind === "event" && wire && (wire.trigger || wire.items.length > 0) ? wire : null

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <PhaseBadge phase={doc.phase} />
          <CycleKindBadge kind={cycle?.kind} />
          <span className="text-muted-foreground text-sm">{formatDateTime(doc.created_at)}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{r.headline}</h1>
        <p className="text-muted-foreground max-w-3xl leading-relaxed">{r.summary}</p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">Sentiment: {titleCase(r.market.sentiment)}</Badge>
          <Badge variant="secondary">Regime: {titleCase(r.market.regime)}</Badge>
          <Badge variant="secondary">Stance: {titleCase(r.market.stance)}</Badge>
          <Badge variant="secondary">Confidence: {r.market.confidence}%</Badge>
          {account && (
            <Badge variant="outline">
              Equity {usd(account.equity)} · day <Delta value={account.day_pnl} percent={account.day_pnl_pct} className="ml-1" />
            </Badge>
          )}
        </div>
      </div>

      {triggeredBy && (
        <Card className="gap-3 border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <ZapIcon className="size-4" aria-hidden /> Triggered by our news engine
              {triggeredBy.trigger && <Badge variant="secondary">{titleCase(triggeredBy.trigger.rule)}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {triggeredBy.trigger && (
              <p className="text-muted-foreground text-xs">
                {titleCase(triggeredBy.trigger.action)} · {triggeredBy.trigger.symbols.join(", ") || "market-wide"} · severity {triggeredBy.trigger.severity} · {triggeredBy.trigger.reason}
              </p>
            )}
            {triggeredBy.items.length > 0 && (
              <ol className="divide-y">
                {triggeredBy.items.map((i) => (
                  <WireItemRow key={i.id} item={i} />
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Key drivers">
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            {r.market.key_drivers.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </Section>
        <Section title="Next focus">
          <p className="text-sm leading-relaxed">{r.next_focus}</p>
          {r.lessons.length > 0 && (
            <>
              <h3 className="mt-4 mb-1.5 text-sm font-medium">Lessons</h3>
              <ul className="list-disc space-y-1.5 pl-5 text-sm">
                {r.lessons.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold">
          Decisions{" "}
          <span className="text-muted-foreground text-sm font-normal">
            {doc.execution.executed} executed · {doc.execution.rejected} rejected · {doc.execution.failed} failed
          </span>
        </h2>
        {decisions.length > 0 || r.decisions.length === 0 ? (
          <DecisionsTable decisions={decisions} />
        ) : (
          <p className="text-muted-foreground text-sm">{r.decisions.length} decisions requested; none recorded.</p>
        )}
      </div>

      {r.watchlist.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-semibold">Watchlist</h2>
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Setup</TableHead>
                  <TableHead className="min-w-64">Thesis & trigger</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Stop / Target</TableHead>
                  <TableHead className="text-right">Conv.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.watchlist.map((w) => (
                  <TableRow key={w.symbol} className="align-top">
                    <TableCell>
                      <SymbolLink symbol={w.symbol} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{titleCase(w.setup)}</TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      <p>{w.thesis}</p>
                      <p className="text-muted-foreground mt-1 text-xs">Trigger: {w.trigger}</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.entry_low || w.entry_high ? `${price(w.entry_low)}–${price(w.entry_high)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(w.stop_loss)} / {price(w.take_profit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{w.conviction}/10</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Catalysts">
          {r.catalysts.length === 0 ? (
            <p className="text-muted-foreground text-sm">None noted.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {r.catalysts.map((c, i) => (
                <li key={i}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.title}</span>
                    <Badge variant="outline">{titleCase(c.impact)}</Badge>
                    {c.time_et && <span className="text-muted-foreground text-xs">{c.time_et} ET</span>}
                    {c.symbols.length > 0 && <span className="text-muted-foreground font-mono text-xs">{c.symbols.join(" ")}</span>}
                  </div>
                  <p className="text-muted-foreground mt-0.5">
                    {c.detail}{" "}
                    {c.source_url && (
                      <a href={c.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        source
                      </a>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Risks">
          <ul className="space-y-3 text-sm">
            {r.risks.map((risk, i) => (
              <li key={i}>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={SEVERITY[risk.severity]}>
                    {titleCase(risk.severity)}
                  </Badge>
                  <span className="font-medium">{risk.risk}</span>
                </div>
                <p className="text-muted-foreground mt-0.5">Mitigation: {risk.mitigation}</p>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Accordion type="multiple" defaultValue={events.length ? ["trail"] : []} className="rounded-xl border px-4">
        {events.length > 0 && (
          <AccordionItem value="trail">
            <AccordionTrigger>Thinking process ({events.length} events)</AccordionTrigger>
            <AccordionContent>
              <CycleTrail cycleId={doc.cycle_id} events={events} triggerItems={triggeredBy?.items.map((i) => ({ id: i.id, title: i.title, url: i.url }))} />
            </AccordionContent>
          </AccordionItem>
        )}
        <AccordionItem value="sources">
          <AccordionTrigger>AI research: sources ({sources.length})</AccordionTrigger>
          <AccordionContent>
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {sources.map((s) => (
                <li key={s.url} className="min-w-0">
                  <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-foreground text-muted-foreground flex items-center gap-1.5">
                    <ExternalLinkIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{s.title || host(s.url)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="research">
          <AccordionTrigger>
            <span className="flex flex-wrap items-center gap-2">
              {mode === "skipped" ? (
                "AI research: Grok memo (skipped)"
              ) : (
                <>
                  AI research: Grok memo ({doc.research.model}
                  {doc.research.x_search ? ", web + X" : ", web only"}, {Math.round(doc.research.duration_ms / 1000)}s)
                </>
              )}
              {mode && mode !== "skipped" && <ResearchModeBadge mode={mode} />}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {mode === "skipped" ? (
              <p className="text-muted-foreground text-sm">
                Grok research was skipped{cycle?.research_skip_reason ? `: ${cycle.research_skip_reason}` : ""}. The decision used our own feeds.
              </p>
            ) : (
              <>
                {mode === "gap_fill" && <p className="text-muted-foreground mb-2 text-sm">Gap-fill: Grok only checked X and what our own feeds lacked.</p>}
                {doc.research.error && <p className="text-loss mb-2 text-sm">Research failed: {doc.research.error}</p>}
                <div className="bg-muted/40 max-h-[32rem] overflow-y-auto rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap">
                  {doc.research.memo || "No memo."}
                </div>
                {doc.research.queries.length > 0 && <p className="text-muted-foreground mt-3 text-xs">Searches: {doc.research.queries.join(" · ")}</p>}
              </>
            )}
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="ours">
          <AccordionTrigger>Our research: news engine ({dossier.length} items)</AccordionTrigger>
          <AccordionContent>
            {dossier.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing from our news engine for this cycle.</p>
            ) : (
              <>
                <p className="text-muted-foreground mb-2 text-xs">What the AI was given from our own feeds (top {dossier.length}, by severity).</p>
                <DossierRows rows={dossier} showTime />
              </>
            )}
          </AccordionContent>
        </AccordionItem>
        {cycle && (
          <AccordionItem value="run">
            <AccordionTrigger>
              Cycle log ({cycle.status}, {cycle.duration_ms ? `${Math.round(cycle.duration_ms / 1000)}s` : "…"})
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1.5 text-sm">
                {cycle.steps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    {s.ok ? <CheckCircle2Icon className="text-gain mt-0.5 size-4 shrink-0" /> : <XCircleIcon className="text-loss mt-0.5 size-4 shrink-0" />}
                    <span className="text-muted-foreground w-20 shrink-0">{formatTime(s.at).replace(" ET", "")}</span>
                    <span className="font-medium">{s.name}</span>
                    {s.detail && <span className="text-muted-foreground">{s.detail}</span>}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Decision model {doc.model} · attempt {doc.attempts} · tokens: research {doc.research.usage.total.toLocaleString()}, decision {doc.usage.total.toLocaleString()} · AI cost{" "}
                {usd(doc.cost_usd)} · trigger: {cycle.trigger}
              </p>
            </AccordionContent>
          </AccordionItem>
        )}
        <AccordionItem value="context">
          <AccordionTrigger>Market data the bot saw</AccordionTrigger>
          <AccordionContent>
            <pre className="bg-muted/40 max-h-[32rem] overflow-auto rounded-lg p-4 text-xs">{JSON.stringify(doc.context, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="raw">
          <AccordionTrigger>Raw structured output</AccordionTrigger>
          <AccordionContent>
            <pre className="bg-muted/40 max-h-[32rem] overflow-auto rounded-lg p-4 text-xs">{JSON.stringify(r, null, 2)}</pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

export function CyclesList({ cycles }: { cycles: CycleDoc[] }) {
  if (cycles.length === 0) return null
  return (
    <div className="divide-y rounded-xl border text-sm">
      {cycles.map((cycle) => (
        <div key={cycle._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
          <PhaseBadge phase={cycle.phase} />
          <span className="text-muted-foreground">{formatTime(cycle.started_at)}</span>
          <StatusBadge status={cycle.status} />
          <CycleKindBadge kind={cycle.kind} />
          {cycle.duration_ms && <span className="text-muted-foreground text-xs">{Math.round(cycle.duration_ms / 1000)}s</span>}
          <span className="text-muted-foreground text-xs">{cycle.trigger}</span>
          {cycle.report_id && (
            <a href={`/research/${cycle.report_id}`} className="text-muted-foreground ml-auto text-xs hover:underline">
              Report
            </a>
          )}
          {cycle.error && <span className="text-loss w-full text-xs">{cycle.error}</span>}
        </div>
      ))}
    </div>
  )
}
