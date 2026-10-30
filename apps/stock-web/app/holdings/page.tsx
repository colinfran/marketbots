import { formatDateTime } from "@mb/stock-core/time"
import { STRATEGY_LABEL } from "@mb/stock-core/options"
import { SETUP_INFO, type Setup } from "@mb/stock-core/setups"
import type { Metadata } from "next"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, PageHeader, PaperBadge, SectionTitle, Stat, SymbolLink } from "@/components/bits"
import { OptionsTable, PositionsTable } from "@/components/tables"
import { getViewer } from "@/lib/auth"
import { pct, price, titleCase, usd } from "@/lib/format"
import { getLiveAccount } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Current holdings",
  description: "What StockMarketBot's AI owns right now in its paper account: every stock and options position, its size, unrealized P&L, stop, target and the thesis behind it.",
  path: "/holdings",
})

function Why({ title, badges, meta, weight, thesis, invalidation, pnl }: { title: React.ReactNode; badges: string[]; meta: string; weight: string; thesis: string; invalidation: string | null; pnl: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {title}
          {badges.map((b) => (
            <Badge key={b} variant="secondary">
              {b}
            </Badge>
          ))}
          <span className="text-muted-foreground ml-auto text-xs font-normal">{weight} of equity</span>
        </CardTitle>
        <CardDescription>{meta}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>{thesis || "No thesis recorded."}</p>
        {invalidation && (
          <p>
            <span className="font-medium">Invalidation:</span> <span className="text-muted-foreground">{invalidation}</span>
          </p>
        )}
        <div className="border-t pt-3 text-xs">{pnl}</div>
      </CardContent>
    </Card>
  )
}

export default async function HoldingsPage() {
  const [viewer, live] = await Promise.all([getViewer(), getLiveAccount()])
  const equity = live?.equity ?? 0
  const share = (value: number) => (equity > 0 ? pct((value / equity) * 100, { sign: false, digits: 1 }) : "—")
  const stocksValue = live?.positions.reduce((sum, p) => sum + p.marketValue, 0) ?? 0
  const invested = stocksValue + (live?.optionsValue ?? 0)
  const cost = (live?.positions.reduce((sum, p) => sum + p.avgEntry * p.qty, 0) ?? 0) + (live?.options.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0) ?? 0)
  const unrealized = (live?.positions.reduce((sum, p) => sum + p.unrealizedPl, 0) ?? 0) + (live?.options.reduce((sum, o) => sum + (o.mark?.pnl_usd ?? 0), 0) ?? 0)
  const setupName = (setup: string) => SETUP_INFO[setup as Setup]?.name ?? titleCase(setup)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Holdings"
        description="Everything the bot owns right now, marked to the broker's latest prices. Each position keeps the thesis, stop and target the AI opened it with. Stock exits rest at the broker; options exits are checked by the engine."
        action={<PaperBadge className="text-sm" />}
      />
      {!live ? (
        <Empty>No account data yet. It appears once the engine has started and synced with Alpaca.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Invested"
              value={usd(invested)}
              sub={
                <span className="text-muted-foreground">
                  {share(invested)} of equity · {live.positions.length} stock{live.positions.length === 1 ? "" : "s"} · {live.options.length} option
                  {live.options.length === 1 ? "" : "s"}
                </span>
              }
            />
            <Stat label="Unrealized" value={<Delta value={unrealized} className="text-2xl" />} sub={<Delta percent={cost > 0 ? (unrealized / cost) * 100 : null} />} />
          </div>
          <section>
            <SectionTitle>Stock positions</SectionTitle>
            <PositionsTable positions={live.positions} owner={viewer.owner} />
          </section>
          <section>
            <SectionTitle>Options positions</SectionTitle>
            <OptionsTable positions={live.options} owner={viewer.owner} />
          </section>
          {live.positions.length + live.options.length > 0 && (
            <section>
              <SectionTitle>Why it holds each one</SectionTitle>
              <div className="grid gap-4 md:grid-cols-2">
                {live.positions.map((p) => (
                  <Why
                    key={p.symbol}
                    title={<SymbolLink symbol={p.symbol} />}
                    badges={p.plan ? [...(p.plan.setup ? [setupName(p.plan.setup)] : []), ...(p.plan.horizon ? [titleCase(p.plan.horizon)] : [])] : []}
                    meta={`${p.plan ? `Opened ${formatDateTime(p.plan.opened_at)} · ` : ""}stop ${price(p.plan?.stop_loss)} · target ${price(p.plan?.take_profit)}`}
                    weight={share(p.marketValue)}
                    thesis={p.plan?.thesis ?? ""}
                    invalidation={p.plan?.invalidation ?? null}
                    pnl={<Delta value={p.unrealizedPl} percent={p.unrealizedPlPct} />}
                  />
                ))}
                {live.options.map((o) => (
                  <Why
                    key={o._id}
                    title={<SymbolLink symbol={o.underlying} />}
                    badges={[STRATEGY_LABEL[o.strategy], `Expires ${o.expiration}`]}
                    meta={`Opened ${formatDateTime(o.opened_at)} · exits at −${o.stop_loss_pct}% / +${o.take_profit_pct}% of value`}
                    weight={share(o.mark ? o.mark.value * 100 * o.qty : (o.cost_usd ?? 0))}
                    thesis={o.thesis}
                    invalidation={o.invalidation}
                    pnl={o.mark ? <Delta value={o.mark.pnl_usd} percent={o.mark.pnl_pct} /> : <span className="text-muted-foreground">No mark yet</span>}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
