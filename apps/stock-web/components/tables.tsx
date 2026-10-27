import type { DecisionDoc, OptionPositionDoc } from "@mb/stock-core/db"
import { daysToExpiry, describeContract, isOptionSymbol, STRATEGY_LABEL } from "@mb/stock-core/options"
import { formatDateTime, formatTime, marketDay } from "@mb/stock-core/time"
import { ZapIcon } from "lucide-react"
import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { price, qty, titleCase, usd } from "@/lib/format"
import type { DecisionRow, LiveAccount, ReportSummary, TradeRow } from "@/lib/queries"
import { ActionBadge, Delta, Empty, PhaseBadge, ResearchModeBadge, StatusBadge, SymbolLink } from "./bits"

function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-xl border">{children}</div>
}

export function PositionsTable({ positions }: { positions: LiveAccount["positions"] }) {
  if (positions.length === 0) return <Empty>No stock positions.</Empty>
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Avg entry</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Unrealized</TableHead>
            <TableHead className="text-right">Stop / Target</TableHead>
            <TableHead>Horizon</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => (
            <TableRow key={p.symbol}>
              <TableCell>
                {p.plan?.thesis ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SymbolLink symbol={p.symbol} className="underline decoration-dotted underline-offset-4" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{p.plan.thesis}</TooltipContent>
                  </Tooltip>
                ) : (
                  <SymbolLink symbol={p.symbol} />
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{qty(p.qty)}</TableCell>
              <TableCell className="text-right tabular-nums">{price(p.avgEntry)}</TableCell>
              <TableCell className="text-right tabular-nums">{price(p.price)}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(p.marketValue)}</TableCell>
              <TableCell className="text-right">
                <Delta value={p.unrealizedPl} percent={p.unrealizedPlPct} />
              </TableCell>
              <TableCell className="text-muted-foreground text-right tabular-nums">
                {price(p.plan?.stop_loss)} / {price(p.plan?.take_profit)}
              </TableCell>
              <TableCell className="text-muted-foreground">{p.plan ? titleCase(p.plan.horizon) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroll>
  )
}

const legsLabel = (o: Pick<OptionPositionDoc, "legs">) => o.legs.map((l) => `${l.side === "short" ? "−" : "+"}${describeContract(l.symbol)}`).join(" / ")

/** Open (or closed) options positions with their live mark and exits. */
export function OptionsTable({ positions, closed = false }: { positions: OptionPositionDoc[]; closed?: boolean }) {
  if (positions.length === 0) return <Empty>{closed ? "No closed options positions yet." : "No open options positions."}</Empty>
  const today = marketDay()
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Underlying</TableHead>
            <TableHead>Position</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">{closed ? "Exit" : "Now"}</TableHead>
            <TableHead className="text-right">{closed ? "Realized" : "Unrealized"}</TableHead>
            <TableHead className="text-right">{closed ? "Closed" : "DTE"}</TableHead>
            <TableHead className="min-w-56">{closed ? "Why" : "Exits"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((o) => (
            <TableRow key={o._id} className="align-top">
              <TableCell>
                <SymbolLink symbol={o.underlying} />
                {o.status !== "open" && o.status !== "closed" && (
                  <div className="mt-1">
                    <StatusBadge status={o.status} />
                  </div>
                )}
              </TableCell>
              <TableCell className="text-sm whitespace-normal">
                <p className="font-medium">{STRATEGY_LABEL[o.strategy]}</p>
                <p className="text-muted-foreground font-mono text-xs">{legsLabel(o)}</p>
              </TableCell>
              <TableCell className="text-right tabular-nums">{o.qty}</TableCell>
              <TableCell className="text-right tabular-nums">
                {price(o.entry_price)}
                <p className="text-muted-foreground text-xs">{usd(o.cost_usd)}</p>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {closed ? price(o.exit_price) : price(o.mark?.value)}
                {!closed && o.mark?.underlying_price != null && <p className="text-muted-foreground text-xs">{o.underlying} {price(o.mark.underlying_price)}</p>}
              </TableCell>
              <TableCell className="text-right">
                {closed ? (
                  o.realized_pnl_usd === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Delta value={o.realized_pnl_usd} percent={o.cost_usd ? (o.realized_pnl_usd / o.cost_usd) * 100 : null} />
                  )
                ) : o.mark ? (
                  <Delta value={o.mark.pnl_usd} percent={o.mark.pnl_pct} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-right tabular-nums">{closed ? (o.closed_at ? formatDateTime(o.closed_at) : "—") : daysToExpiry(o.expiration, today)}</TableCell>
              <TableCell className="text-muted-foreground text-xs whitespace-normal">
                {closed ? (
                  <>
                    <p>{o.exit_reason ? titleCase(o.exit_reason) : "—"}</p>
                    <p className="mt-0.5 line-clamp-2">{o.thesis}</p>
                  </>
                ) : (
                  <>
                    <p>
                      −{o.stop_loss_pct}% / +{o.take_profit_pct}% of value
                    </p>
                    {(o.underlying_stop !== null || o.underlying_target !== null) && (
                      <p>
                        {o.underlying} stop {price(o.underlying_stop)} · target {price(o.underlying_target)}
                      </p>
                    )}
                    <p className="mt-0.5 line-clamp-2">{o.thesis}</p>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroll>
  )
}

const decisionDetail = (d: DecisionDoc) => {
  if (d.option) {
    const legs = d.option.legs.map((l) => `${l.side === "short" ? "−" : "+"}${describeContract(l.symbol)}`).join(" / ")
    const size = d.option.contracts ? ` · ${d.option.contracts} × ${price(d.option.limit_price ?? d.price)}` : ""
    return `${STRATEGY_LABEL[d.option.strategy]} ${legs}${size}${d.option.cost_usd ? ` (${usd(d.option.cost_usd)})` : ""}`
  }
  if (!d.qty && !d.stop_loss) return null
  return `${d.qty ? `${qty(d.qty)} sh @ ${price(d.price)}` : ""}${d.notional ? ` (${usd(d.notional)})` : ""}${d.stop_loss ? ` · stop ${price(d.stop_loss)} · target ${price(d.take_profit)}` : ""}`
}

/** What started the decision, when it wasn't the schedule: the news items behind an event cycle, or the seed buy. */
function TriggeredBy({ d }: { d: DecisionRow }) {
  if (d.trigger_kind === "seed") return <p className="text-muted-foreground mt-1 text-xs">Part of the owner&apos;s one-time seed buy.</p>
  if (d.trigger_kind !== "event") return null
  const items = d.triggered_by ?? []
  return (
    <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
      <ZapIcon className="mr-1 inline size-3 align-[-2px]" aria-hidden />
      Triggered by our news engine{items.length ? ": " : ""}
      {items.map((i, n) => (
        <span key={i.id}>
          {n > 0 && " · "}
          {i.url ? (
            <a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
              {i.title}
            </a>
          ) : (
            i.title
          )}
        </span>
      ))}
    </p>
  )
}

export function DecisionsTable({ decisions, showDay = false }: { decisions: DecisionRow[]; showDay?: boolean }) {
  if (decisions.length === 0) return <Empty>No decisions yet.</Empty>
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Action</TableHead>
            <TableHead className="text-right">Conv.</TableHead>
            <TableHead className="min-w-72">Rationale</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {decisions.map((d) => {
            const extra = decisionDetail(d)
            const failedCheck = d.checks?.find((c) => !c.ok)
            return (
              <TableRow key={d._id} className="align-top">
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  <Link prefetch href={`/research/${d.report_id}`} className="hover:underline">
                    {showDay ? formatDateTime(d.created_at) : formatTime(d.created_at)}
                  </Link>
                </TableCell>
                <TableCell>
                  <SymbolLink symbol={d.symbol} />
                </TableCell>
                <TableCell>
                  <ActionBadge action={d.action} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{d.request.conviction}/10</TableCell>
                <TableCell className="text-sm whitespace-normal">
                  <p>{d.request.rationale}</p>
                  {extra && <p className="text-muted-foreground mt-1 text-xs tabular-nums">{extra}</p>}
                  <TriggeredBy d={d} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-col items-start gap-1">
                    {d.checks?.length ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help">
                            <StatusBadge status={d.status} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <ul className="space-y-0.5 text-xs">
                            {d.checks.map((c, i) => (
                              <li key={i}>
                                {c.ok ? "✓" : "✗"} {c.name}: {c.detail}
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <StatusBadge status={d.status} />
                    )}
                    {(d.reason ?? failedCheck?.detail) && <span className="text-muted-foreground max-w-56 text-xs">{d.reason ?? failedCheck?.detail}</span>}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Scroll>
  )
}

const ROLE_LABEL: Record<TradeRow["role"], string> = {
  entry: "Entry",
  exit: "Exit",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  spread: "Spread",
}

export function TradesTable({ trades, showDay = true }: { trades: TradeRow[]; showDay?: boolean }) {
  if (trades.length === 0) return <Empty>No trades yet.</Empty>
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Filled</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Realized P&L</TableHead>
            <TableHead className="min-w-64">Why</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => {
            const option = isOptionSymbol(t.symbol)
            return (
              <TableRow key={t.id} className="align-top">
                <TableCell className="text-muted-foreground whitespace-nowrap">{showDay ? formatDateTime(t.at) : formatTime(t.at)}</TableCell>
                <TableCell>
                  {option ? (
                    <span className="flex flex-col">
                      <SymbolLink symbol={t.underlying ?? t.symbol} />
                      <span className="text-muted-foreground font-mono text-xs">{describeContract(t.symbol)}</span>
                    </span>
                  ) : (
                    <SymbolLink symbol={t.symbol} />
                  )}
                </TableCell>
                <TableCell>
                  <ActionBadge action={t.side} />
                </TableCell>
                <TableCell className="text-muted-foreground">{option ? `Option ${ROLE_LABEL[t.role].toLowerCase()}` : ROLE_LABEL[t.role]}</TableCell>
                <TableCell className="text-right tabular-nums">{qty(t.qty)}</TableCell>
                <TableCell className="text-right tabular-nums">{price(t.price)}</TableCell>
                <TableCell className="text-right tabular-nums">{usd(t.qty * t.price * (option ? 100 : 1))}</TableCell>
                <TableCell className="text-right">
                  {t.realized_pnl === null ? <span className="text-muted-foreground">—</span> : <Delta value={t.realized_pnl} percent={t.cost_basis ? ((t.price - t.cost_basis) / t.cost_basis) * 100 * (t.side === "buy" ? -1 : 1) : null} />}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-normal">
                  {t.report_id ? (
                    <Link prefetch href={`/research/${t.report_id}`} className="hover:text-foreground hover:underline">
                      {t.rationale}
                    </Link>
                  ) : (
                    (t.rationale ?? "—")
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Scroll>
  )
}

export function ReportList({ reports, showDay = true }: { reports: ReportSummary[]; showDay?: boolean }) {
  if (reports.length === 0) return <Empty>No reports yet. The first one is written at the next premarket briefing.</Empty>
  return (
    <div className="divide-y rounded-xl border">
      {reports.map((r) => (
        <Link prefetch key={r._id} href={`/research/${r._id}`} className="hover:bg-muted/50 flex flex-col gap-1.5 p-4 transition-colors sm:flex-row sm:items-center sm:gap-4">
          <div className="flex shrink-0 items-center gap-2 sm:w-48">
            <PhaseBadge phase={r.phase} />
            <span className="text-muted-foreground text-xs whitespace-nowrap">{showDay ? formatDateTime(r.created_at) : formatTime(r.created_at)}</span>
          </div>
          <p className="flex-1 text-sm font-medium">{r.headline}</p>
          <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
            <ResearchModeBadge mode={r.research_mode} />
            <span>{titleCase(r.sentiment)}</span>
            <span>
              {r.execution.executed}/{r.decisions} executed
            </span>
          </div>
        </Link>
      ))}
    </div>
  )
}

export function DayRows({
  days,
}: {
  days: {
    day: string
    stats: { pnl: number; pnl_pct: number; spy_pct?: number | null; end_equity: number; wins: number; losses: number; orders_filled: number } | null
    decisions: { total: number; executed: number }
  }[]
}) {
  if (days.length === 0) return <Empty>No trading days recorded yet.</Empty>
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead className="text-right">P&L</TableHead>
            <TableHead className="text-right">SPY</TableHead>
            <TableHead className="text-right">End equity</TableHead>
            <TableHead className="text-right">Fills</TableHead>
            <TableHead className="text-right">Wins / Losses</TableHead>
            <TableHead className="text-right">Decisions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map(({ day, stats, decisions }) => (
            <TableRow key={day}>
              <TableCell>
                <Link prefetch href={`/journal/${day}`} className="font-medium hover:underline">
                  {new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                </Link>
              </TableCell>
              <TableCell className="text-right">{stats ? <Delta value={stats.pnl} percent={stats.pnl_pct} /> : <span className="text-muted-foreground">in progress</span>}</TableCell>
              <TableCell className="text-right">{stats?.spy_pct != null ? <Delta percent={stats.spy_pct} /> : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{stats ? usd(stats.end_equity) : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{stats?.orders_filled ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{stats ? `${stats.wins} / ${stats.losses}` : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {decisions.executed}/{decisions.total}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroll>
  )
}
