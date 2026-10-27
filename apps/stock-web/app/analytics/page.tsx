import { formatDateTime } from "@mb/stock-core/time"
import { SETUP_INFO } from "@mb/stock-core/setups"
import type { Metadata } from "next"
import Link from "next/link"
import { AiCostRows, NewsFunnelCard, SpendByTaskCard } from "@mb/ui/analytics"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Delta, Empty, PageHeader, SectionTitle, Stat, SymbolLink } from "@/components/bits"
import { CumulativePnlChart, DailyPnlChart, EquityChart } from "@/components/charts"
import { num, pct, titleCase, usd } from "@/lib/format"
import { cumulativePnl, getAiCosts, getEquitySeries, getLiveAccount, getSettings, getSetupStats, getWireAnalytics, listDailyStats, listTrades, summarizeBySymbol } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Performance analytics",
  description: "StockMarketBot's paper-trading returns, green days, drawdowns, win rates and results against SPY, plus performance by setup and by stock and what the AI costs to run.",
  path: "/analytics",
})

/** Compounds daily % changes into one % return. */
const compound = (pcts: number[]) => (pcts.length ? (pcts.reduce((acc, p) => acc * (1 + p / 100), 1) - 1) * 100 : null)

export default async function AnalyticsPage() {
  const [live, stats, series, trades, costs, { setups }, settings, w] = await Promise.all([
    getLiveAccount(),
    listDailyStats(),
    getEquitySeries(),
    listTrades(5000),
    getAiCosts(30),
    getSetupStats(),
    getSettings(),
    getWireAnalytics(),
  ])
  const start = settings.account.starting_capital
  const closed = trades.filter((t) => t.realized_pnl !== null)
  const grossWin = closed.reduce((s, t) => s + Math.max(0, t.realized_pnl ?? 0), 0)
  const grossLoss = -closed.reduce((s, t) => s + Math.min(0, t.realized_pnl ?? 0), 0)
  const wins = closed.filter((t) => (t.realized_pnl ?? 0) > 0).length
  const green = stats.filter((s) => s.pnl > 0).length
  const benchmarked = [...stats].reverse().filter((s) => s.spy_pct != null)
  const beatSpy = benchmarked.filter((s) => s.pnl_pct > s.spy_pct!).length
  const botVsSpy = compound(benchmarked.map((s) => s.pnl_pct))
  const spy = compound(benchmarked.map((s) => s.spy_pct!))
  // Drawdown from the running peak of daily closing equity (the starting balance counts as the first peak).
  let peak = start
  let maxDd = 0
  for (const s of [...stats].reverse()) {
    peak = Math.max(peak, s.end_equity)
    maxDd = Math.min(maxDd, (s.end_equity / peak - 1) * 100)
  }
  const bySymbol = summarizeBySymbol(trades)
  const traded = setups.filter((s) => s.entries > 0).sort((a, b) => b.realized - a.realized)
  const totalCost = costs.reduce((s, c) => s + c.cost, 0)
  const days = stats
    .slice(0, 120)
    .reverse()
    .map((s) => ({ day: s.trading_day, pnl: s.pnl, pnl_pct: s.pnl_pct }))

  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        description="Paper results and whether the AI is beating the market it trades. Small samples are noise: the system never changes its rules or prompts automatically based on a handful of trades."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total return" value={<Delta percent={live?.totalPnlPct ?? null} className="text-2xl" />} sub={<span className="text-muted-foreground">{usd(live?.totalPnl)} since start</span>} />
        <Stat
          label="Green days"
          value={stats.length ? `${green}/${stats.length}` : "—"}
          sub={
            <span className="text-muted-foreground">
              {stats.length ? `${Math.round((green / stats.length) * 100)}% of days profitable` : "No completed days yet"}
              {benchmarked.length > 0 && ` · beat SPY ${beatSpy}/${benchmarked.length}`}
            </span>
          }
        />
        <Stat label="Max drawdown" value={stats.length ? pct(maxDd) : "—"} sub={<span className="text-muted-foreground">from daily closing equity</span>} />
        <Stat
          label="Closed trades"
          value={closed.length}
          sub={
            <span className="text-muted-foreground">
              win rate {closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} · profit factor {grossLoss > 0 ? num(grossWin / grossLoss) : "—"}
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Portfolio value</CardTitle>
            <CardDescription>Dashed line is the {usd(start, { whole: true })} starting balance.</CardDescription>
          </CardHeader>
          <CardContent>
            <EquityChart series={series} baseline={start} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Realized P&L over time</CardTitle>
            <CardDescription>Running total; each step is one closing trade. Hover for the symbol and amount.</CardDescription>
          </CardHeader>
          <CardContent>
            <CumulativePnlChart points={cumulativePnl(trades)} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Daily P&L</CardTitle>
            <CardDescription>Each bar is one trading day. Bars above zero are green days.</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyPnlChart days={days} />
          </CardContent>
        </Card>
      </div>

      <section className="space-y-4">
        <SectionTitle>Is the AI beating the market?</SectionTitle>
        <p className="text-muted-foreground max-w-3xl text-sm">
          The benchmark is SPY over the same trading days ({benchmarked.length} with a SPY close recorded so far). Buying SPY and doing nothing is the bar every active
          strategy has to clear.
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Bot, compounded" value={<Delta percent={botVsSpy} className="text-2xl" />} />
          <Stat label="SPY, same days" value={<Delta percent={spy} className="text-2xl" />} />
          <Stat
            label="Difference"
            value={<Delta percent={botVsSpy !== null && spy !== null ? botVsSpy - spy : null} className="text-2xl" />}
            sub={<span className="text-muted-foreground">percentage points</span>}
          />
          <Stat
            label="Days beating SPY"
            value={benchmarked.length ? `${beatSpy}/${benchmarked.length}` : "—"}
            sub={<span className="text-muted-foreground">{benchmarked.length ? `${Math.round((beatSpy / benchmarked.length) * 100)}% of days` : "No benchmarked days yet"}</span>}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle
            action={
              <Link href="/strategies" className="text-muted-foreground text-sm hover:underline">
                All setups
              </Link>
            }
          >
            By setup
          </SectionTitle>
          {traded.length === 0 ? (
            <Empty>No trades yet.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Setup</TableHead>
                    <TableHead className="text-right">Entries</TableHead>
                    <TableHead className="text-right">Closed</TableHead>
                    <TableHead className="text-right">Win rate</TableHead>
                    <TableHead className="text-right">Net P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traded.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="text-sm">{SETUP_INFO[s.key].name}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.executed}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.closed}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.closed ? `${Math.round((s.wins / s.closed) * 100)}%` : "—"}</TableCell>
                      <TableCell className="text-right">
                        <Delta value={s.realized} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
        <section>
          <SectionTitle>By symbol</SectionTitle>
          {bySymbol.length === 0 ? (
            <Empty>No trades yet.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Realized P&L</TableHead>
                    <TableHead className="text-right">Closed</TableHead>
                    <TableHead className="text-right">Wins / Losses</TableHead>
                    <TableHead className="text-right">Last traded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bySymbol.map((s) => (
                    <TableRow key={s.symbol}>
                      <TableCell>
                        <SymbolLink symbol={s.symbol} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Delta value={s.realized} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.closed}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.wins} / {s.losses}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right">{formatDateTime(s.last_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>

      <section>
        <SectionTitle>AI cost, last 30 days: ${totalCost.toFixed(2)}</SectionTitle>
        {costs.length === 0 ? (
          <Empty>No AI calls yet.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <AiCostRows costs={costs} />
            </Table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>News engine</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-3">
          <NewsFunnelCard funnel={w.funnel} medianLatencyS={w.medianLatencyS} latencySamples={w.latencySamples} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outcomes by what started the trade</CardTitle>
              <CardDescription>Entries, and the realized P&L of the positions they opened.</CardDescription>
            </CardHeader>
            <CardContent>
              {w.byKind.every((k) => k.entries === 0) ? (
                <Empty>No entries yet.</Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Started by</TableHead>
                      <TableHead className="text-right text-xs">Entries</TableHead>
                      <TableHead className="text-right text-xs">Win rate</TableHead>
                      <TableHead className="text-right text-xs">Net P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...w.byKind.map((k) => ({ key: k.kind, ...k })), ...w.byCategory.map((c) => ({ key: `news:${c.category}`, label: `News: ${titleCase(c.category)}`, ...c }))]
                      .filter((row) => row.entries > 0)
                      .map((row) => (
                        <TableRow key={row.key}>
                          <TableCell className="text-xs">{row.label}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{row.executed}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{row.closed ? `${Math.round((row.wins / row.closed) * 100)}%` : "—"}</TableCell>
                          <TableCell className="text-right text-xs">
                            <Delta value={row.realized} />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <SpendByTaskCard
            title="Grok spend per day by task"
            description="Gap-fill research and skipped research came with the news engine."
            dayLabel="Day (ET)"
            days={w.researchSpend}
            empty="No AI calls yet."
          />
        </div>
      </section>
    </div>
  )
}
