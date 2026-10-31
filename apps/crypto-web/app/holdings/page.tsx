import type { Metadata } from "next"
import Link from "next/link"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, PageHeader, PaperBadge, SectionTitle, Stat, SymbolLink } from "@/components/bits"
import { PositionsTable } from "@/components/tables"
import { getViewer } from "@/lib/auth"
import { getAccount } from "@/lib/data"
import { ago, pct, price, titleCase, usd } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Current holdings",
  description: "What CryptoMarketBot's AI owns right now in its Kraken paper wallet: every coin, its size, unrealized P&L, stop, target and the thesis behind it.",
  path: "/holdings",
})

export default async function HoldingsPage() {
  const [viewer, data] = await Promise.all([getViewer(), getAccount()])
  const equity = data?.account.equity_usd ?? 0
  const share = (value: number) => (equity > 0 ? pct((value / equity) * 100, { sign: false, digits: 1 }) : "—")
  return (
    <div className="space-y-8">
      <PageHeader
        title="Holdings"
        description="Everything the bot owns right now, marked to live Kraken prices. Each position keeps the thesis, stop and target the AI opened it with, and the engine checks the stop and target every few seconds."
        action={<PaperBadge className="text-sm" />}
      />
      {!data ? (
        <Empty>No paper account yet. Start the engine: it creates the wallet on first boot.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Invested"
              value={usd(data.marketValue)}
              sub={
                <span className="text-muted-foreground">
                  {share(data.marketValue)} of equity · {data.positions.length} position{data.positions.length === 1 ? "" : "s"}
                </span>
              }
            />
            <Stat
              label="Unrealized"
              value={<Delta value={data.unrealized} className="text-2xl" />}
              sub={<Delta percent={data.invested > 0 ? (data.unrealized / data.invested) * 100 : null} />}
            />
          </div>
          <section>
            <SectionTitle>Positions</SectionTitle>
            <PositionsTable positions={data.positions} owner={viewer.owner} />
          </section>
          {data.positions.length > 0 && (
            <section>
              <SectionTitle>Why it holds each one</SectionTitle>
              <div className="grid gap-4 md:grid-cols-2">
                {data.positions.map((p) => {
                  const value = p.qty * (p.mark_price ?? p.avg_price)
                  const pnl = value - p.cost_basis_usd
                  return (
                    <Card key={p._id}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <SymbolLink symbol={p.symbol} />
                          {p.strategy_id && <Badge variant="secondary">{titleCase(p.strategy_id)}</Badge>}
                          <span className="text-muted-foreground ml-auto text-xs font-normal">{share(value)} of equity</span>
                        </CardTitle>
                        <CardDescription>
                          Opened {ago(p.opened_at)} · stop {price(p.stop_price)} · target {price(p.take_profit_price)}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 text-sm">
                        <p>{p.thesis ?? "No thesis recorded."}</p>
                        {p.invalidation && (
                          <p>
                            <span className="font-medium">Invalidation:</span> <span className="text-muted-foreground">{p.invalidation}</span>
                          </p>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
                          <Delta value={pnl} percent={p.cost_basis_usd > 0 ? (pnl / p.cost_basis_usd) * 100 : null} />
                          {p.decision_id && (
                            <Link prefetch href={`/decisions/${p.decision_id}`} className="text-muted-foreground hover:underline">
                              Opening decision
                            </Link>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
