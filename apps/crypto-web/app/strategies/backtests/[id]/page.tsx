import type { PerformanceMetrics, TradeStats } from "@mb/crypto-core/metrics"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Delta, Empty, PageHeader, SectionTitle, StatusBadge, SymbolLink } from "@/components/bits"
import { EquityChart } from "@/components/charts"
import { getBacktest } from "@/lib/data"
import { dateTime, num, pct, price, titleCase } from "@/lib/format"
import { clip, pageMetadata } from "@/lib/site"

/** One fetch per request, shared by the metadata and the page. */
const loadBacktest = cache(getBacktest)

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const b = await loadBacktest(id).catch(() => null)
  if (!b) return { title: "Backtest not found", robots: { index: false } }
  const strategies = b.params.strategies.map(titleCase).join(", ")
  const result = b.metrics?.total_return_pct != null ? `: ${pct(b.metrics.total_return_pct)} total return` : ""
  return pageMetadata({
    title: clip(`Backtest: ${strategies}`, 70),
    description: clip(`${strategies} backtested on ${b.params.symbols.join(", ")} after ${b.params.fee_bps} bps fees and ${b.params.slippage_bps} bps slippage per side${result}.`, 160),
    path: `/strategies/backtests/${id}`,
  })
}

const ROWS: [keyof PerformanceMetrics, string, (v: number | null) => string][] = [
  ["total_return_pct", "Total return", (v) => pct(v)],
  ["annualized_return_pct", "Annualized", (v) => pct(v)],
  ["sharpe", "Sharpe", (v) => num(v)],
  ["sortino", "Sortino", (v) => num(v)],
  ["max_drawdown_pct", "Max drawdown", (v) => pct(v)],
  ["volatility_pct", "Volatility (ann.)", (v) => pct(v, { sign: false })],
  ["trades", "Trades", (v) => num(v, 0)],
  ["win_rate_pct", "Win rate", (v) => pct(v, { sign: false, digits: 1 })],
  ["profit_factor", "Profit factor", (v) => num(v)],
  ["avg_return_pct", "Avg trade", (v) => pct(v, { digits: 3 })],
  ["exposure_pct", "Time in market", (v) => pct(v, { sign: false, digits: 0 })],
  ["turnover", "Turnover (× equity)", (v) => num(v, 1)],
]

function StatsTable({ rows }: { rows: Record<string, TradeStats> }) {
  const entries = Object.entries(rows)
  if (!entries.length) return <Empty>No trades.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead />
          <TableHead className="text-right">Trades</TableHead>
          <TableHead className="text-right">Win rate</TableHead>
          <TableHead className="text-right">Avg trade</TableHead>
          <TableHead className="text-right">Profit factor</TableHead>
          <TableHead className="text-right">Net P&L</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([k, s]) => (
          <TableRow key={k}>
            <TableCell className="text-sm">{k.includes("/") ? <SymbolLink symbol={k} /> : titleCase(k)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{s.trades}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{pct(s.win_rate_pct, { sign: false, digits: 0 })}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{pct(s.avg_return_pct, { digits: 3 })}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{num(s.profit_factor)}</TableCell>
            <TableCell className="text-right">
              <Delta value={s.total_pnl_usd} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default async function BacktestPage({ params }: { params: Promise<{ id: string }> }) {
  const b = await loadBacktest((await params).id)
  if (!b) notFound()
  const sets: [string, PerformanceMetrics | null][] = [
    ["Full period", b.metrics],
    ["In-sample", b.in_sample],
    ["Out-of-sample", b.out_of_sample],
  ]
  return (
    <div className="space-y-8">
      <PageHeader
        title={`Backtest · ${dateTime(b.created_at)}`}
        description={`${b.params.symbols.join(", ")} · ${b.params.strategies.map(titleCase).join(", ")} · fee ${b.params.fee_bps} bps + slippage ${b.params.slippage_bps} bps per side`}
        action={<StatusBadge status={b.status} />}
      />
      {b.error && <p className="text-loss text-sm">{b.error}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Equity</CardTitle>
          </CardHeader>
          <CardContent>
            <EquityChart points={b.equity_curve} baseline={b.params.starting_usd} />
            <p className="text-muted-foreground mt-2 text-xs">
              Benchmarks over the same window: buy-and-hold BTC {pct(b.benchmarks.buy_hold_btc_pct)}, equal-weight selected pairs {pct(b.benchmarks.equal_weight_pct)}.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  {sets.map(([label]) => (
                    <TableHead key={label} className="text-right text-xs">
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ROWS.map(([key, label, fmt]) => (
                  <TableRow key={key}>
                    <TableCell className="text-muted-foreground text-xs">{label}</TableCell>
                    {sets.map(([name, m]) => (
                      <TableCell key={name} className="text-right font-mono text-xs tabular-nums">
                        {m ? fmt((m[key] as number | null) ?? null) : "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <section>
          <SectionTitle>By strategy</SectionTitle>
          <StatsTable rows={b.by_strategy} />
        </section>
        <section>
          <SectionTitle>By pair</SectionTitle>
          <StatsTable rows={b.by_symbol} />
        </section>
        <section>
          <SectionTitle>By market regime</SectionTitle>
          <StatsTable rows={b.by_regime} />
        </section>
      </div>
      <section>
        <SectionTitle>Trades ({b.trades.length}{b.trades.length >= 500 ? ", latest 500" : ""})</SectionTitle>
        {b.trades.length === 0 ? (
          <Empty>No trades.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Pair</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead>Exit reason</TableHead>
                <TableHead className="text-right">Return</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...b.trades].reverse().map((t, i) => (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{dateTime(t.entry_at)}</TableCell>
                  <TableCell>
                    <SymbolLink symbol={t.symbol} />
                  </TableCell>
                  <TableCell className="text-sm">{titleCase(t.strategy)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{price(t.entry_price)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{price(t.exit_price)}</TableCell>
                  <TableCell className="text-sm">{titleCase(t.exit_reason)}</TableCell>
                  <TableCell className="text-right">
                    <Delta percent={t.return_pct} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Delta value={t.pnl_usd} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
        {b.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  )
}
