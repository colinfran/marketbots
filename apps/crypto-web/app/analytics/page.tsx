import type { Metadata } from "next"
import Link from "next/link"
import { AiCostRows, NewsFunnelCard, SpendByTaskCard } from "@mb/ui/analytics"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Delta, Empty, PageHeader, SectionTitle, Stat } from "@/components/bits"
import { DailyPnlChart, DrawdownChart, EquityChart } from "@/components/charts"
import { getAccount, getAiCosts, getAnalytics, getDailyStats, getEquitySeries, getWireAnalytics } from "@/lib/data"
import { num, pct, titleCase, usd } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Performance analytics",
  description: "Paper-trading returns after fees and slippage, drawdowns, win rates and whether the AI's crypto calls are actually adding value.",
  path: "/analytics",
})

const rate = (correct: number, judged: number) => (judged ? `${Math.round((correct / judged) * 100)}%` : "—")

export default async function AnalyticsPage() {
  const [a, account, curve, daily, costs, w] = await Promise.all([getAnalytics(), getAccount(), getEquitySeries(365), getDailyStats(120), getAiCosts(30), getWireAnalytics()])
  const t = a.trades
  const r = a.risk
  const base = a.decisions.baseline
  const cal = a.decisions.calibration
  const totalCost = costs.reduce((s, c) => s + c.cost, 0)
  // Today (UTC) is still running, so only finished days count toward green days.
  const today = new Date().toISOString().slice(0, 10)
  const finished = daily.filter((d) => d.day < today)
  const green = finished.filter((d) => d.pnl_usd > 0).length
  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        description="Paper results after fees and slippage, and whether the AI is actually adding value. Small samples are noise: the system never changes strategies or prompts automatically based on a handful of trades."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total return" value={<Delta percent={account?.totalReturnPct ?? null} className="text-2xl" />} sub={<span className="text-muted-foreground">{usd(account?.totalPnl)} since start</span>} />
        <Stat label="Sharpe / Sortino" value={`${num(r.sharpe)} / ${num(r.sortino)}`} sub={<span className="text-muted-foreground">from 5-min equity snapshots</span>} />
        <Stat label="Max drawdown" value={pct(r.max_drawdown_pct)} sub={<span className="text-muted-foreground">longest {num(r.max_drawdown_hours, 0)}h below peak</span>} />
        <Stat
          label="Green days"
          value={finished.length ? `${green}/${finished.length}` : "—"}
          sub={
            <span className="text-muted-foreground">
              {finished.length ? `${Math.round((green / finished.length) * 100)}% of days profitable` : "No completed days yet"} · profit factor {num(t.profit_factor)}
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Portfolio value</CardTitle>
          </CardHeader>
          <CardContent>
            <EquityChart points={curve} baseline={account?.account.starting_usd ?? 10_000} height={220} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Drawdown from peak</CardTitle>
          </CardHeader>
          <CardContent>
            <DrawdownChart points={a.drawdown} height={220} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Daily P&L (UTC days)</CardTitle>
            <CardDescription>Blue bars above zero are up days, red bars below zero are down days.</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyPnlChart days={[...daily].reverse().map((d) => ({ day: d.day, pnl: d.pnl_usd, pnl_pct: d.pnl_pct }))} />
          </CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle
          action={
            <Link href="/strategies" className="text-muted-foreground text-sm hover:underline">
              By strategy
            </Link>
          }
        >
          By pair
        </SectionTitle>
        {a.bySymbol.length === 0 ? (
          <Empty>No closed trades yet.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win rate</TableHead>
                <TableHead className="text-right">Net P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.bySymbol.map((s) => (
                <TableRow key={s.key}>
                  <TableCell className="font-mono text-sm">{s.key}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{s.trades}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{pct(s.win_rate_pct, { sign: false, digits: 0 })}</TableCell>
                  <TableCell className="text-right">
                    <Delta value={s.total_pnl_usd} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-4">
        <SectionTitle>Is the AI adding value?</SectionTitle>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Every decision is scored after its horizon against what the price actually did ({a.decisions.scored} scored so far). The baseline is the quant screen alone,
          which would have bought every candidate it proposed.
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI vs the no-AI screen</CardTitle>
              <CardDescription>Average forward return of screened candidates.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {base.candidates === 0 ? (
                <p className="text-muted-foreground">No scored candidates yet.</p>
              ) : (
                <>
                  <p className="flex justify-between">
                    <span>Screen alone (all {base.candidates})</span>
                    <Delta percent={base.screenAvgReturnPct} />
                  </p>
                  <p className="flex justify-between">
                    <span>AI bought ({base.aiBought})</span>
                    <Delta percent={base.aiBoughtAvgReturnPct} />
                  </p>
                  <p className="flex justify-between">
                    <span>AI skipped ({base.aiSkipped})</span>
                    <Delta percent={base.aiSkippedAvgReturnPct} />
                  </p>
                  <p className="text-muted-foreground pt-2 text-xs">The AI adds value if what it buys beats what it skips, after costs, over a meaningful sample.</p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Hit rate by action</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {a.decisions.byAction.map((x) => (
                    <TableRow key={x.action}>
                      <TableCell className="text-sm">{titleCase(x.action)}</TableCell>
                      <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                        {x.correct}/{x.judged}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{rate(x.correct, x.judged)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Calibration: target before stop</CardTitle>
              <CardDescription>Brier score, lower is better ({cal.n} resolved buys).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-muted-foreground text-xs">AI raw</p>
                  <p className="font-mono tabular-nums">{num(cal.brierAi, 3)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Shrunk (used)</p>
                  <p className="font-mono tabular-nums">{num(cal.brierAdjusted, 3)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Random walk</p>
                  <p className="font-mono tabular-nums">{num(cal.brierPrior, 3)}</p>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">AI said</TableHead>
                    <TableHead className="text-right text-xs">n</TableHead>
                    <TableHead className="text-right text-xs">Actually hit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cal.table.map((b) => (
                    <TableRow key={b.lo}>
                      <TableCell className="font-mono text-xs">
                        {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{b.n}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{b.hit_rate === null ? "—" : `${Math.round(b.hit_rate * 100)}%`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">By model and prompt version</CardTitle>
            </CardHeader>
            <CardContent>
              {a.decisions.byModel.length === 0 ? (
                <p className="text-muted-foreground text-sm">No scored decisions yet.</p>
              ) : (
                <Table>
                  <TableBody>
                    {a.decisions.byModel.map((m) => (
                      <TableRow key={m.key}>
                        <TableCell className="font-mono text-xs">{m.key}</TableCell>
                        <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{m.n} decisions</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{rate(m.correct, m.judged)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI cost, last 30 days: ${totalCost.toFixed(2)}</CardTitle>
            </CardHeader>
            <CardContent>
              {costs.length === 0 ? (
                <p className="text-muted-foreground text-sm">No AI calls yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Day (UTC)</TableHead>
                      <TableHead className="text-right text-xs">Calls</TableHead>
                      <TableHead className="text-right text-xs">Failed</TableHead>
                      <TableHead className="text-right text-xs">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <AiCostRows costs={costs} />
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle>News engine</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-3">
          <NewsFunnelCard funnel={w.funnel} medianLatencyS={w.medianLatencyS} latencySamples={w.latencySamples} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Decisions judged right, by what started them</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Started by</TableHead>
                    <TableHead className="text-right text-xs">Scored</TableHead>
                    <TableHead className="text-right text-xs">Right</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...w.byKind, ...w.byCategory.map((c) => ({ kind: `news: ${c.category.replace(/_/g, " ")}`, ...c }))].map((row) => (
                    <TableRow key={row.kind}>
                      <TableCell className="text-xs">{row.kind.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{row.judged}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{row.correct_pct === null ? "—" : `${row.correct_pct}%`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <SpendByTaskCard title="AI spend per day by task" dayLabel="Day (UTC)" days={w.researchSpend} />
        </div>
      </section>
    </div>
  )
}
