import type { Metadata } from "next"
import { ExternalLinkIcon, ZapIcon } from "lucide-react"
import { notFound } from "next/navigation"
import { cache } from "react"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { WireItemRow } from "@mb/ui/wire"
import { Empty, KV, PageHeader, SectionTitle, StatusBadge, SymbolLink } from "@/components/bits"
import { DecisionCard } from "@/components/decision-card"
import { getCycle, getWireForCycle } from "@/lib/data"
import { dateTime, duration, titleCase } from "@/lib/format"
import { clip, pageMetadata } from "@/lib/site"

type Props = { params: Promise<{ id: string }> }

/** One fetch per request, shared by the metadata and the page. */
const loadCycle = cache(getCycle)

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const data = await loadCycle(id).catch(() => null)
  if (!data) return { title: "Cycle not found", robots: { index: false } }
  const { cycle, decisions } = data
  const symbols = [...new Set(decisions.map((d) => d.symbol))]
  return pageMetadata({
    title: clip(`AI research: ${symbols.join(", ") || "market scan"} · ${dateTime(cycle.started_at)}`, 70),
    description: clip(cycle.summary ?? `The AI's research memo, sources and trade decisions for the ${dateTime(cycle.started_at)} crypto trading cycle.`, 160),
    path: `/research/${id}`,
    type: "article",
    publishedTime: cycle.started_at.toISOString(),
  })
}

export default async function CyclePage({ params }: Props) {
  const id = (await params).id
  const [data, wire] = await Promise.all([loadCycle(id), getWireForCycle(id).catch(() => null)])
  if (!data) notFound()
  const { cycle, research, decisions } = data
  return (
    <div className="space-y-8">
      <PageHeader
        title={`Cycle · ${dateTime(cycle.started_at)}`}
        description={cycle.summary ?? cycle.error ?? "In progress…"}
        action={<StatusBadge status={cycle.status} />}
      />
      {wire?.kind === "event" && (wire.trigger || wire.items.length > 0) && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ZapIcon className="size-4" aria-hidden /> Triggered by our news engine
              {wire.trigger && <Badge variant="secondary">{titleCase(wire.trigger.rule)}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="divide-y">
              {wire.items.map((i) => (
                <WireItemRow key={i.id} item={i} summary="open" />
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run</CardTitle>
          </CardHeader>
          <CardContent>
            <KV label="Trigger">{cycle.trigger}</KV>
            <KV label="Duration">{duration(cycle.duration_ms)}</KV>
            <KV label="AI cost">${cycle.ai_cost_usd.toFixed(4)}</KV>
            <KV label="Prompt / settings">
              {cycle.prompt_version} / v{cycle.settings_version}
            </KV>
            {cycle.regime && (
              <>
                <KV label="Regime">{titleCase(cycle.regime.label)}</KV>
                <p className="text-muted-foreground mt-2 text-xs">{cycle.regime.notes.join(". ")}</p>
              </>
            )}
            <details className="mt-3 text-xs">
              <summary className="text-muted-foreground cursor-pointer">Step log</summary>
              <ol className="mt-2 space-y-1">
                {cycle.steps.map((s, i) => (
                  <li key={i} className={s.ok ? "text-muted-foreground" : "text-loss"}>
                    {s.ok ? "✓" : "✗"} {s.name}: {s.detail}
                  </li>
                ))}
              </ol>
            </details>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Candidates from the quant screens</CardTitle>
          </CardHeader>
          <CardContent>
            {cycle.candidates.length === 0 ? (
              <p className="text-muted-foreground text-sm">No new candidates{cycle.reviews.length ? `; reviewed ${cycle.reviews.join(", ")}` : ""}.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {cycle.candidates.map((c) => (
                  <li key={c.instrument} className="flex flex-wrap items-baseline gap-2">
                    <SymbolLink symbol={c.instrument} />
                    <Badge variant="secondary">{titleCase(c.strategy)}</Badge>
                    <span className="text-muted-foreground font-mono text-xs">score {c.score}</span>
                    <span className="text-muted-foreground">{c.signal}</span>
                  </li>
                ))}
              </ul>
            )}
            {cycle.reviews.length > 0 && cycle.candidates.length > 0 && <p className="text-muted-foreground mt-3 text-xs">Positions reviewed: {cycle.reviews.join(", ")}</p>}
          </CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle>
          AI research {wire?.mode && <Badge variant="outline" className="ml-2 align-middle font-normal">{wire.mode === "gap_fill" ? "gap-fill" : wire.mode}</Badge>}
        </SectionTitle>
        {wire?.skipReason && <p className="text-muted-foreground mb-3 text-sm">Web research was skipped: {wire.skipReason}. The decision used our own feeds.</p>}
        {!research ? (
          <Empty>No research ran this cycle.</Empty>
        ) : wire?.mode === "skipped" ? null : (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-muted-foreground text-xs font-normal">
                  {research.model} · {research.x_search ? "web + X search" : "web search"} · {duration(research.duration_ms)} · ${research.cost_usd.toFixed(4)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {research.error && <p className="text-loss mb-3 text-sm">Research failed: {research.error}. Decisions used exchange data only.</p>}
                {/* Rendered as plain text: memos are model output built from untrusted web content. */}
                <div className="text-sm leading-relaxed whitespace-pre-wrap">{research.memo || "—"}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sources ({research.sources.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-1.5 text-sm">
                  {research.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
                        {s.title}
                      </a>
                      <span className="text-muted-foreground ml-1 inline-flex items-center gap-0.5 text-xs">
                        {s.domain} <ExternalLinkIcon className="size-3" aria-hidden />
                      </span>
                    </li>
                  ))}
                </ul>
                {research.queries.length > 0 && (
                  <details className="text-xs">
                    <summary className="text-muted-foreground cursor-pointer">Searches ({research.queries.length})</summary>
                    <ul className="text-muted-foreground mt-2 space-y-0.5">
                      {research.queries.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Our research</SectionTitle>
        {!wire?.dossier.length ? (
          <Empty>Nothing from our news engine for this cycle.</Empty>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-muted-foreground text-xs font-normal">What the AI was given from our own feeds (top {wire.dossier.length}, by severity)</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="divide-y">
                {wire.dossier.map((r) => (
                  <li key={r.id} className="flex gap-2.5 py-2 text-sm">
                    <span className="text-muted-foreground w-8 shrink-0 font-mono text-xs tabular-nums">{r.severity}</span>
                    <div className="min-w-0">
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
                          {r.title}
                        </a>
                      ) : (
                        r.title
                      )}
                      <p className="text-muted-foreground text-xs">
                        {dateTime(r.at)} · {r.symbols.join(", ") || "market-wide"} · {titleCase(r.category)} · {r.source} · T{r.tier}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}
      </section>

      <section>
        <SectionTitle>Decisions ({decisions.length})</SectionTitle>
        {decisions.length === 0 ? <Empty>No decisions this cycle.</Empty> : <div className="space-y-4">{decisions.map((d) => <DecisionCard key={d._id} d={d} />)}</div>}
      </section>
    </div>
  )
}
