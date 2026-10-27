import type { CycleDoc, DailyStatsDoc, DecisionDoc, FillDoc, OrderDoc, PositionDoc } from "@mb/crypto-core/db"
import Link from "next/link"
import { ActionBadge, Delta, Empty, StatusBadge, SymbolLink } from "@/components/bits"
import { CommandButton } from "@/components/command"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ago, dateTime, duration, formatDay, num, price, qty, titleCase, usd } from "@/lib/format"

/** Data tables. Each is also the accessible table view of the corresponding chart. */

export function PositionsTable({ positions, owner }: { positions: PositionDoc[]; owner: boolean }) {
  if (!positions.length) return <Empty>No open positions. The wallet is all USD.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pair</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Mark</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Unrealized</TableHead>
          <TableHead className="text-right">Stop / target</TableHead>
          <TableHead>Strategy</TableHead>
          <TableHead>Opened</TableHead>
          {owner && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p) => {
          const mark = p.mark_price ?? p.avg_price
          const value = p.qty * mark
          const pnl = value - p.cost_basis_usd
          return (
            <TableRow key={p._id}>
              <TableCell>
                <SymbolLink symbol={p.symbol} />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{qty(p.qty)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{price(p.avg_price)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{price(mark)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{usd(value)}</TableCell>
              <TableCell className="text-right">
                <Delta value={pnl} percent={p.cost_basis_usd > 0 ? (pnl / p.cost_basis_usd) * 100 : null} />
              </TableCell>
              <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                {price(p.stop_price)} / {price(p.take_profit_price)}
              </TableCell>
              <TableCell className="text-sm">{p.strategy_id ? titleCase(p.strategy_id) : "—"}</TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {p.decision_id ? (
                  <Link href={`/decisions/${p.decision_id}`} className="hover:underline">
                    {ago(p.opened_at)}
                  </Link>
                ) : (
                  ago(p.opened_at)
                )}
              </TableCell>
              {owner && (
                <TableCell>
                  <CommandButton
                    command={{ type: "position.close", position_id: p._id }}
                    label="Close"
                    size="xs"
                    confirm={{ title: `Close ${p.symbol}?`, description: `Sells ${qty(p.qty)} ${p.symbol} at market in the paper wallet.`, action: "Sell at market" }}
                  />
                </TableCell>
              )}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function ClosedPositionsTable({ positions }: { positions: PositionDoc[] }) {
  if (!positions.length) return <Empty>No closed trades yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pair</TableHead>
          <TableHead className="text-right">Realized</TableHead>
          <TableHead>Exit</TableHead>
          <TableHead>Strategy</TableHead>
          <TableHead>Held</TableHead>
          <TableHead>Closed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p) => (
          <TableRow key={p._id}>
            <TableCell>
              <SymbolLink symbol={p.symbol} />
            </TableCell>
            <TableCell className="text-right">
              <Delta value={p.realized_pnl_usd} />
            </TableCell>
            <TableCell className="text-sm">{titleCase(p.exit_reason ?? "—")}</TableCell>
            <TableCell className="text-sm">{p.strategy_id ? titleCase(p.strategy_id) : "—"}</TableCell>
            <TableCell className="text-muted-foreground text-sm">{p.closed_at ? duration(p.closed_at.getTime() - p.opened_at.getTime()) : "—"}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {p.decision_id ? (
                <Link href={`/decisions/${p.decision_id}`} className="hover:underline">
                  {dateTime(p.closed_at)}
                </Link>
              ) : (
                dateTime(p.closed_at)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function OrdersTable({ orders }: { orders: OrderDoc[] }) {
  if (!orders.length) return <Empty>No orders yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Pair</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Purpose</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Filled</TableHead>
          <TableHead className="text-right">Avg price</TableHead>
          <TableHead className="text-right">Fees</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Note</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((o) => (
          <TableRow key={o._id}>
            <TableCell className="text-muted-foreground text-sm whitespace-nowrap">{dateTime(o.created_at)}</TableCell>
            <TableCell>
              <SymbolLink symbol={o.symbol} />
            </TableCell>
            <TableCell className="font-mono text-xs uppercase">{o.side}</TableCell>
            <TableCell className="text-sm">{titleCase(o.purpose)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{qty(o.qty)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{qty(o.filled_qty)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{price(o.avg_fill_price)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{usd(o.fees_usd)}</TableCell>
            <TableCell>
              <StatusBadge status={o.status} />
            </TableCell>
            <TableCell className="text-muted-foreground max-w-64 truncate text-xs" title={o.reason ?? undefined}>
              {o.decision_id ? (
                <Link href={`/decisions/${o.decision_id}`} className="hover:underline">
                  {o.reason ?? "decision"}
                </Link>
              ) : (
                (o.reason ?? "")
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function FillsTable({ fills }: { fills: FillDoc[] }) {
  if (!fills.length) return <Empty>No fills yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Pair</TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Fee</TableHead>
          <TableHead className="text-right">Slippage</TableHead>
          <TableHead className="text-right">Realized</TableHead>
          <TableHead>Purpose</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fills.map((f) => (
          <TableRow key={f._id}>
            <TableCell className="text-muted-foreground text-sm whitespace-nowrap">{dateTime(f.at)}</TableCell>
            <TableCell>
              <SymbolLink symbol={f.symbol} />
            </TableCell>
            <TableCell className="font-mono text-xs uppercase">{f.side}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{qty(f.qty)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{price(f.price)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{usd(f.fee_usd)}</TableCell>
            <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{f.slippage_bps === null ? "—" : `${num(f.slippage_bps, 1)} bps`}</TableCell>
            <TableCell className="text-right">{f.realized_pnl_usd === null ? <span className="text-muted-foreground">—</span> : <Delta value={f.realized_pnl_usd} />}</TableCell>
            <TableCell className="text-sm">{titleCase(f.purpose)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function DecisionsTable({ decisions }: { decisions: DecisionDoc[] }) {
  if (!decisions.length) return <Empty>No AI decisions yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Pair</TableHead>
          <TableHead>Action</TableHead>
          <TableHead className="text-right">Conviction</TableHead>
          <TableHead className="text-right">Net edge</TableHead>
          <TableHead>Risk</TableHead>
          <TableHead>Execution</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead className="w-[38%]">Thesis</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map((d) => (
          <TableRow key={d._id}>
            <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
              <Link href={`/decisions/${d._id}`} className="hover:underline">
                {dateTime(d.created_at)}
              </Link>
            </TableCell>
            <TableCell>
              <SymbolLink symbol={d.symbol} />
            </TableCell>
            <TableCell>
              <ActionBadge action={d.action} />
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{d.ai.conviction}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">{d.ev.net_edge_bps === null ? "—" : `${num(d.ev.net_edge_bps, 0)} bps`}</TableCell>
            <TableCell>{d.risk ? <StatusBadge status={d.risk.approved ? "approved" : "rejected"} label={d.risk.approved ? (d.risk.resized ? "Resized" : "Approved") : "Rejected"} /> : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
            <TableCell>
              <StatusBadge status={d.execution.status} />
            </TableCell>
            <TableCell className="text-sm">
              {d.outcome ? (
                <span title={d.outcome.forward_return_pct !== null ? `${d.outcome.forward_return_pct}% over ${d.outcome.horizon_hours}h` : undefined}>
                  {d.outcome.correct === null ? "—" : d.outcome.correct ? "✓ right" : "✗ wrong"}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">pending</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground line-clamp-2 text-xs">{d.ai.thesis}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function CyclesTable({ cycles }: { cycles: CycleDoc[] }) {
  if (!cycles.length) return <Empty>No cycles yet. The engine runs one every scan interval.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Regime</TableHead>
          <TableHead className="text-right">Candidates</TableHead>
          <TableHead className="text-right">Decisions</TableHead>
          <TableHead className="text-right">AI cost</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="w-[34%]">Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cycles.map((c) => (
          <TableRow key={c._id}>
            <TableCell className="text-sm whitespace-nowrap">
              <Link href={`/research/${c._id}`} className="hover:underline">
                {dateTime(c.started_at)}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground max-w-40 truncate text-xs">{c.trigger}</TableCell>
            <TableCell>
              <StatusBadge status={c.status} />
            </TableCell>
            <TableCell className="text-sm">{c.regime ? titleCase(c.regime.label) : "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{c.candidates.length}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{c.decision_ids.length}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">{c.ai_cost_usd ? `$${c.ai_cost_usd.toFixed(3)}` : "—"}</TableCell>
            <TableCell className="text-muted-foreground text-right text-xs">{duration(c.duration_ms)}</TableCell>
            <TableCell className="text-muted-foreground line-clamp-2 text-xs">{c.error ?? c.summary}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function DayRows({ days }: { days: { day: string; stats: DailyStatsDoc | null; decisions: { total: number; executed: number } }[] }) {
  if (!days.length) return <Empty>No trading days recorded yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Day (UTC)</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead className="text-right">End equity</TableHead>
          <TableHead className="text-right">Fills</TableHead>
          <TableHead className="text-right">Wins / Losses</TableHead>
          <TableHead className="text-right">Fees</TableHead>
          <TableHead className="text-right">Decisions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map(({ day, stats, decisions }) => (
          <TableRow key={day}>
            <TableCell>
              <Link href={`/journal/${day}`} className="font-medium hover:underline">
                {formatDay(day)}
              </Link>
            </TableCell>
            <TableCell className="text-right">{stats ? <Delta value={stats.pnl_usd} percent={stats.pnl_pct} /> : <span className="text-muted-foreground text-sm">in progress</span>}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{stats ? usd(stats.end_equity_usd) : "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{stats?.trades ?? "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{stats ? `${stats.wins} / ${stats.losses}` : "—"}</TableCell>
            <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{stats ? usd(stats.fees_usd) : "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {decisions.executed}/{decisions.total}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
