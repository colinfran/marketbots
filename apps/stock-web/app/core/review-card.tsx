import type { CoreDecisionRecord, CoreReviewDoc } from "@mb/stock-core/db"
import { formatDateTime } from "@mb/stock-core/time"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import Link from "next/link"
import { ActionBadge, StatusBadge, SymbolLink } from "@/components/bits"
import { pct, price, usd } from "@/lib/format"

/** A review's title: weekly, or the holding a news review was about. */
export const reviewTitle = (r: Pick<CoreReviewDoc, "kind" | "symbol" | "created_at">) => `${r.kind === "holding" ? `${r.symbol} review (news)` : "Weekly review"} · ${formatDateTime(r.created_at)}`

/** One decision as a line: what was asked, what happened, and why. */
export function DecisionLine({ d }: { d: CoreDecisionRecord }) {
  const weight = d.weight_after_pct !== null && d.weight_after_pct !== d.weight_before_pct ? `${pct(d.weight_before_pct, { sign: false, digits: 1 })} → ${pct(d.weight_after_pct, { sign: false, digits: 1 })}` : null
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <SymbolLink symbol={d.symbol} className="font-medium" />
      <ActionBadge action={d.action} />
      {(d.action !== "keep" || d.status !== "noop") && <StatusBadge status={d.status} />}
      {d.qty !== null && (
        <span className="text-muted-foreground tabular-nums">
          {d.qty} shares{d.price !== null ? ` at ${price(d.price)}` : ""}
        </span>
      )}
      {weight && <span className="text-muted-foreground tabular-nums">{weight} of equity</span>}
      {d.stop !== null && <span className="text-muted-foreground tabular-nums">stop {price(d.stop)}</span>}
      {(d.request?.verdict || d.reason) && <span className="text-muted-foreground basis-full text-xs">{[d.request?.verdict, d.status === "rejected" || d.status === "failed" ? d.reason : null].filter(Boolean).join(" · ")}</span>}
    </li>
  )
}

/** A review on the Core page: when and why it ran, what it concluded and did, and what it's watching. */
export function ReviewCard({ review }: { review: CoreReviewDoc }) {
  const trades = review.decisions.filter((d) => d.action !== "keep" || d.request)
  return (
    <Card id={`review-${review._id}`} className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Link href={`/core/reviews/${review._id}`} className="hover:underline">
            {reviewTitle(review)}
          </Link>
          {review.dry_run && <Badge variant="secondary">Dry run</Badge>}
          <StatusBadge status={review.status} />
        </CardTitle>
        <CardDescription>
          {review.trigger === "schedule" ? "Scheduled" : review.trigger === "manual" ? "Run by the owner" : review.trigger}
          {review.book_before && ` · core book ${pct(review.book_before.core_pct, { sign: false, digits: 1 })} of equity before`}
          {review.book_after && review.status === "done" && !review.dry_run && `, ${pct(review.book_after.core_pct, { sign: false, digits: 1 })} after`}
          {` · AI ${usd(review.cost_usd)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {review.summary && <p className="text-sm">{review.summary}</p>}
        {review.error && <p className="text-loss text-sm">{review.error}</p>}
        {trades.length > 0 && (
          <ul className="space-y-2">
            {trades.map((d) => (
              <DecisionLine key={`${d.symbol}-${d.action}`} d={d} />
            ))}
          </ul>
        )}
        {review.watch.length > 0 && (
          <div className="border-t pt-3 text-sm">
            <p className="mb-1 font-medium">Watching</p>
            <ul className="space-y-1">
              {review.watch.map((w) => (
                <li key={w.symbol} className="text-muted-foreground">
                  <SymbolLink symbol={w.symbol} className="text-foreground font-medium" />: {w.reason} <span className="text-xs">Buys if: {w.trigger}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
