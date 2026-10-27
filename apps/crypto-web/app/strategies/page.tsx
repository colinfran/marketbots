import { STRATEGIES, STRATEGY_IDS } from "@mb/crypto-core/strategies"
import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import type { Metadata } from "next"
import Link from "next/link"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Delta, Empty, PageHeader, SectionTitle, StatusBadge } from "@/components/bits"
import { CommandButton } from "@/components/command"
import { getViewer } from "@/lib/auth"
import { getAnalytics, getBacktests, getEngine, getSettings } from "@/lib/data"
import { dateTime, num, pct } from "@/lib/format"
import { pageMetadata } from "@/lib/site"
import { BacktestForm } from "./backtest-form"

export const metadata: Metadata = pageMetadata({
  title: "Trading strategies and backtests",
  description: "The trend, mean-reversion, momentum and event-driven screens that propose crypto trades to the AI, and how each is backtested.",
  path: "/strategies",
})

export default async function StrategiesPage() {
  const [viewer, settingsDoc, analytics, backtests, engine] = await Promise.all([getViewer(), getSettings(), getAnalytics(), getBacktests(15), getEngine()])
  const parsed = settingsSchema.safeParse(settingsDoc?.settings)
  const settings = parsed.success ? parsed.data : DEFAULT_SETTINGS
  const perf = new Map(analytics.byStrategy.map((s) => [s.key, s]))
  const wallet = engine.status?.paper_wallet
  return (
    <div className="space-y-8">
      <PageHeader
        title="Strategies"
        description="Strategies propose candidates from deterministic screens; the AI decides which, if any, to trade; the risk engine has the final word. Each one states why it should make money and how that claim is tested."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {STRATEGY_IDS.map((id) => {
          const info = STRATEGIES[id]
          const cfg = settings.strategies[id]
          const p = perf.get(id)
          return (
            <Card key={id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {info.name}
                  <Badge variant={cfg.enabled ? "secondary" : "outline"}>{cfg.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="text-muted-foreground ml-auto text-xs font-normal">max {cfg.max_exposure_pct}% of equity</span>
                </CardTitle>
                <CardDescription>{info.summary}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>
                  <span className="font-medium">Why it should work: </span>
                  <span className="text-muted-foreground">{info.rationale}</span>
                </p>
                <p>
                  <span className="font-medium">AI&apos;s role: </span>
                  <span className="text-muted-foreground">{info.ai_role}</span>
                </p>
                <p>
                  <span className="font-medium">How it&apos;s evaluated: </span>
                  <span className="text-muted-foreground">{info.evaluation}</span>
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  {p ? (
                    <span className="text-muted-foreground text-xs">
                      {p.trades} closed trades · win rate {pct(p.win_rate_pct, { sign: false, digits: 0 })} · net <Delta value={p.total_pnl_usd} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">No closed paper trades yet.</span>
                  )}
                  {viewer.owner && (
                    <CommandButton command={{ type: "strategy.set_enabled", strategy: id, enabled: !cfg.enabled }} label={cfg.enabled ? "Disable" : "Enable"} size="xs" />
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <section>
        <SectionTitle>Backtests (deterministic baseline, no AI)</SectionTitle>
        <p className="text-muted-foreground mb-4 max-w-3xl text-sm">
          Backtests replay the quant screens bar by bar with fees, slippage, stops and position limits, and no look-ahead. The AI is left out on purpose: a model asked
          about past bars has likely seen what happened next in its training data. AI value is measured forward instead, on the Analytics page, against this baseline.
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {backtests.length === 0 ? (
              <Empty>No backtests yet.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Setup</TableHead>
                    <TableHead className="text-right">Return</TableHead>
                    <TableHead className="text-right">vs BTC</TableHead>
                    <TableHead className="text-right">Sharpe</TableHead>
                    <TableHead className="text-right">Max DD</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Out-of-sample</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backtests.map((b) => (
                    <TableRow key={b._id}>
                      <TableCell className="text-sm whitespace-nowrap">
                        <Link href={`/strategies/backtests/${b._id}`} className="hover:underline">
                          {dateTime(b.created_at)}
                        </Link>{" "}
                        {b.status !== "completed" && <StatusBadge status={b.status} />}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {b.params.symbols.length} pairs · {b.params.interval === 1440 ? "1d" : `${b.params.interval / 60}h`} · {b.params.strategies.join(", ")}
                      </TableCell>
                      <TableCell className="text-right">
                        <Delta percent={b.metrics?.total_return_pct ?? null} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{pct(b.benchmarks.buy_hold_btc_pct)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{num(b.metrics?.sharpe)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{pct(b.metrics?.max_drawdown_pct)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{b.metrics?.trades ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <Delta percent={b.out_of_sample?.total_return_pct ?? null} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          {viewer.owner && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">New backtest</CardTitle>
              </CardHeader>
              <CardContent>
                <BacktestForm universe={settings.universe.kraken_symbols} feeBps={wallet?.fee_bps ?? settings.kraken.taker_fee_bps} slippageBps={wallet?.slippage_bps ?? settings.kraken.paper_slippage_bps} />
              </CardContent>
            </Card>
          )}
        </div>
      </section>
    </div>
  )
}
