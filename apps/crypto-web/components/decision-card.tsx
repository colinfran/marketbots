import type { DecisionDoc } from "@mb/crypto-core/db"
import Link from "next/link"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { ActionBadge, EvidenceList, KV, StatusBadge, SymbolLink } from "@/components/bits"
import { dateTime, num, pct, price, qty, titleCase, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * One decision, end to end: what the AI proposed and why (evidence for and against, risks,
 * invalidation), what the numbers said (costs, edge, size), what the risk engine decided, what
 * actually executed, and later, how it turned out.
 */
export function DecisionCard({ d, link = true }: { d: DecisionDoc; link?: boolean }) {
  const failed = d.risk?.checks.filter((c) => !c.ok) ?? []
  return (
    <Card id={d._id}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <SymbolLink symbol={d.symbol} />
          <ActionBadge action={d.action} />
          {d.strategy_id && <Badge variant="secondary">{titleCase(d.strategy_id)}</Badge>}
          <span className="text-muted-foreground text-xs font-normal">
            conviction {d.ai.conviction}/100 · {d.ai.uncertainty} uncertainty · {d.held ? "held position" : "candidate"}
          </span>
          {link && (
            <Link prefetch href={`/decisions/${d._id}`} className="text-muted-foreground ml-auto text-xs font-normal hover:underline">
              {dateTime(d.created_at)}
            </Link>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-sm leading-relaxed">{d.ai.thesis}</p>
          {d.quant.signal && <p className="text-muted-foreground mt-1 text-xs">Screen signal: {d.quant.signal}</p>}
          {d.ai.notes.length > 0 && <p className="text-muted-foreground mt-1 text-xs">Adjusted by validation: {d.ai.notes.join("; ")}</p>}
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Evidence for</h3>
            <EvidenceList items={d.ai.bull_evidence} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Evidence against</h3>
            <EvidenceList items={d.ai.bear_evidence} />
          </div>
        </div>
        {(d.ai.risks.length > 0 || d.ai.invalidation) && (
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium">Risks</h3>
              <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-sm">
                {d.ai.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium">Invalidation</h3>
              <p className="text-muted-foreground text-sm">{d.ai.invalidation}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Horizon {d.ai.horizon_hours}h · priced in: {titleCase(d.ai.priced_in)}
              </p>
            </div>
          </div>
        )}
        <div className="grid gap-5 md:grid-cols-3">
          <div>
            <h3 className="mb-1 text-sm font-medium">Market & costs</h3>
            <KV label="Price">{price(d.quant.price)}</KV>
            <KV label="Spread">{d.costs.spread_bps === null ? "—" : `${num(d.costs.spread_bps, 1)} bps`}</KV>
            <KV label="Fee per side">{d.costs.fee_bps === null ? "—" : `${num(d.costs.fee_bps, 1)} bps`}</KV>
            <KV label="Round trip est.">{d.costs.round_trip_bps === null ? "—" : `${num(d.costs.round_trip_bps, 1)} bps`}</KV>
            <KV label="Data age">{d.data_age_s === null ? "—" : `${num(d.data_age_s, 1)}s`}</KV>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Edge</h3>
            <KV label="AI p(target first)">{d.ai.p_target_first === null ? "—" : pct(d.ai.p_target_first * 100, { sign: false, digits: 1 })}</KV>
            <KV label="Random-walk prior">{d.ev.p_prior === null ? "—" : pct(d.ev.p_prior * 100, { sign: false, digits: 1 })}</KV>
            <KV label="Shrunk estimate">{d.ev.p_adjusted === null ? "—" : pct(d.ev.p_adjusted * 100, { sign: false, digits: 1 })}</KV>
            <KV label="Net edge">{d.ev.net_edge_bps === null ? "—" : `${num(d.ev.net_edge_bps, 1)} bps`}</KV>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Size</h3>
            <KV label="Proposed">{d.sizing.qty === null ? "—" : `${qty(d.sizing.qty)} (${usd(d.sizing.notional_usd)})`}</KV>
            <KV label="Risk to stop">{usd(d.sizing.risk_usd)}</KV>
            <KV label="Stop / target">
              {price(d.sizing.stop_price ?? d.ai.stop_loss)} / {price(d.sizing.take_profit_price ?? d.ai.take_profit)}
            </KV>
            <KV label="AI size preference">{d.ai.size_pct_of_max === null ? "—" : `${d.ai.size_pct_of_max}% of max`}</KV>
          </div>
        </div>
        {d.risk && (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
              Risk engine <StatusBadge status={d.risk.approved ? "approved" : "rejected"} label={d.risk.approved ? (d.risk.resized ? "Approved, resized" : "Approved") : "Rejected"} />
            </h3>
            {failed.length > 0 && (
              <ul className="mb-2 space-y-0.5 text-sm">
                {failed.map((c) => (
                  <li key={c.name} className="text-loss">
                    ✗ {titleCase(c.name)}: {c.detail}
                  </li>
                ))}
              </ul>
            )}
            <details className="text-sm">
              <summary className="text-muted-foreground cursor-pointer text-xs">All {d.risk.checks.length} checks</summary>
              <ul className="mt-2 grid gap-x-6 gap-y-0.5 md:grid-cols-2">
                {d.risk.checks.map((c) => (
                  <li key={c.name} className={cn("text-xs", c.ok ? "text-muted-foreground" : "text-loss")}>
                    {c.ok ? "✓" : "✗"} {titleCase(c.name)}: {c.detail}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3 text-sm">
          <span className="inline-flex items-center gap-2">
            Execution <StatusBadge status={d.execution.status} />
          </span>
          {d.execution.filled_qty > 0 && (
            <span className="text-muted-foreground">
              filled {qty(d.execution.filled_qty)} @ {price(d.execution.avg_price)}
            </span>
          )}
          {d.execution.notes.length > 0 && <span className="text-muted-foreground text-xs">{d.execution.notes.join("; ")}</span>}
          <span className="text-muted-foreground ml-auto text-xs">
            {d.model} · {d.prompt_version} · settings v{d.settings_version} · baseline: {d.quant.baseline_action.replace("_", " ")}
          </span>
        </div>
        {d.outcome && (
          <div className="bg-muted/40 rounded-lg p-3 text-sm">
            <span className="font-medium">Outcome after {d.outcome.horizon_hours}h: </span>
            {d.outcome.correct === null ? "not judged" : d.outcome.correct ? "✓ the decision was right" : "✗ the decision was wrong"}
            <span className="text-muted-foreground">
              {" "}
              · forward return {pct(d.outcome.forward_return_pct)} · first level hit: {d.outcome.hit ?? "n/a"}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
