import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Empty, KV, PageHeader, SectionTitle, StatusBadge, SymbolLink } from "@/components/bits"
import { pct, usd } from "@/lib/format"
import { getCoreReview } from "@/lib/queries"
import { DecisionLine, reviewTitle } from "../../review-card"

export const metadata: Metadata = { title: "Core review", robots: { index: false, follow: true } }

export default async function CoreReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const review = await getCoreReview(id)
  if (!review) notFound()
  const research = review.research
  const before = review.book_before
  const after = review.book_after

  return (
    <div className="space-y-8">
      <Link href="/core" className="text-muted-foreground text-sm hover:underline">
        ← Core book
      </Link>
      <PageHeader
        title={reviewTitle(review)}
        description={review.summary ?? review.error ?? "No summary."}
        action={
          <span className="flex gap-2">
            {review.dry_run && <Badge variant="secondary">Dry run: nothing traded</Badge>}
            <StatusBadge status={review.status} />
          </span>
        }
      />

      <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <KV label="Started by">{review.trigger}</KV>
        <KV label="Core book before">{before ? `${usd(before.core_value)} · ${pct(before.core_pct, { sign: false, digits: 1 })} of equity` : "—"}</KV>
        <KV label="After">{after && !review.dry_run ? `${usd(after.core_value)} · ${pct(after.core_pct, { sign: false, digits: 1 })} of equity` : "—"}</KV>
        <KV label="AI">{`${review.model ?? "—"} · ${usd(review.cost_usd)}`}</KV>
      </div>
      {review.adopted.length > 0 && <p className="text-muted-foreground text-sm">Adopted from the one-time seed at the start: {review.adopted.join(", ")}.</p>}

      <section className="space-y-3">
        <SectionTitle>Decisions</SectionTitle>
        {review.decisions.length === 0 ? (
          <Empty>No decisions.</Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {review.decisions.map((d) => (
              <Card key={`${d.symbol}-${d.action}`}>
                <CardHeader>
                  <CardTitle className="text-base">
                    <ul>
                      <DecisionLine d={d} />
                    </ul>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {d.request ? (
                    <>
                      <p>{d.request.thesis}</p>
                      <p>
                        <span className="font-medium">Invalidation:</span> <span className="text-muted-foreground">{d.request.invalidation}</span>
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Conviction {d.request.conviction}/10
                        {d.request.target_weight_pct !== null && ` · asked ${pct(d.request.target_weight_pct, { sign: false, digits: 1 })} of equity`}
                        {d.request.theme && ` · theme ${d.request.theme}`}
                      </p>
                      {d.request.evidence.length > 0 && (
                        <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
                          {d.request.evidence.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="text-muted-foreground">{d.reason}</p>
                  )}
                  {d.checks.length > 0 && (
                    <details className="text-xs">
                      <summary className="text-muted-foreground cursor-pointer">Rules checked ({d.checks.length})</summary>
                      <ul className="mt-1 space-y-0.5">
                        {d.checks.map((c) => (
                          <li key={c.name} className={c.ok ? "text-muted-foreground" : "text-loss"}>
                            {c.ok ? "✓" : "✗"} {c.name}: {c.detail}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {review.watch.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Watching</SectionTitle>
          <ul className="space-y-1 text-sm">
            {review.watch.map((w) => (
              <li key={w.symbol}>
                <SymbolLink symbol={w.symbol} className="font-medium" />: {w.reason} <span className="text-muted-foreground">Buys if: {w.trigger}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <SectionTitle>Research</SectionTitle>
        {!research ? (
          <Empty>No research: the review stopped before it.</Empty>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {research.model}
              {research.x_search ? ", web + X" : ", web only"} · {Math.round(research.duration_ms / 1000)}s · {usd(research.cost_usd ?? 0)}
              {research.queries.length > 0 && ` · searches: ${research.queries.join(" · ")}`}
            </p>
            {research.error && <p className="text-loss text-sm">Research failed: {research.error}</p>}
            <div className="bg-muted/40 max-h-[40rem] overflow-y-auto rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap">{research.memo || "No memo."}</div>
            {research.sources.length > 0 && (
              <ul className="grid gap-1 text-xs sm:grid-cols-2">
                {research.sources.map((s) => (
                  <li key={s.url} className="truncate">
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-muted-foreground hover:text-foreground underline underline-offset-2">
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  )
}
