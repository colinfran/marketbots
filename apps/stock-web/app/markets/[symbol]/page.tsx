import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { LivePrice } from "@mb/ui/live"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, SectionTitle, Stat } from "@/components/bits"
import { PriceChart, type PriceLevel } from "@/components/charts"
import { DecisionsTable, OptionsTable, TradesTable } from "@/components/tables"
import { price, qty, titleCase, usd } from "@/lib/format"
import { getSymbolPage, summarizeBySymbol } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase()
  return pageMetadata({
    title: `${symbol} trades by an AI trading bot`,
    description: `${symbol} price chart with every stock and options trade made by StockMarketBot's AI, plus realized profit and loss and the reasoning behind each ${symbol} trade.`,
    path: `/markets/${encodeURIComponent(symbol)}`,
  })
}

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase()
  if (!/^[A-Z][A-Z.]{0,9}$/.test(symbol)) notFound()
  const { trades, decisions, plan, position, charts, options } = await getSymbolPage(symbol)
  const openOptions = options.filter((o) => o.status !== "closed")
  const lastClose = charts.find((c) => c.key === "1D")?.rows.at(-1)?.c ?? charts.find((c) => c.key === "6M")?.rows.at(-1)?.c ?? null
  const summary = summarizeBySymbol(trades)[0]
  const held = position ? Number(position.qty) : 0

  const levels: PriceLevel[] = []
  if (position && plan?.stop_loss) levels.push({ label: "Stop", value: plan.stop_loss })
  if (position && plan?.take_profit) levels.push({ label: "Target", value: plan.take_profit })
  if (position) levels.push({ label: "Avg entry", value: Number(position.avg_entry_price) })

  return (
    <div className="space-y-8">
      <div>
        <Link prefetch href="/markets" className="text-muted-foreground text-sm hover:underline">
          ← Markets
        </Link>
        <h1 className="mt-2 flex flex-wrap items-baseline gap-3 font-mono text-2xl font-semibold tracking-tight">
          {symbol}
          <LivePrice symbol={symbol} initial={position ? Number(position.current_price) : lastClose} className="text-muted-foreground text-lg font-normal" />
        </h1>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Position"
          value={position ? `${qty(held)} sh` : "None"}
          sub={position && <span className="text-muted-foreground">avg {price(Number(position.avg_entry_price))} · now {price(Number(position.current_price))}</span>}
        />
        <Stat
          label="Unrealized"
          value={position ? <Delta value={Number(position.unrealized_pl)} className="text-2xl" /> : "—"}
          sub={position && <Delta percent={Number(position.unrealized_plpc) * 100} />}
        />
        <Stat
          label="Realized P&L"
          value={<Delta value={summary?.realized ?? 0} className="text-2xl" />}
          sub={<span className="text-muted-foreground">{summary ? `${summary.wins} wins · ${summary.losses} losses` : "No closed trades"}</span>}
        />
        <Stat label="Decisions" value={decisions.length} sub={<span className="text-muted-foreground">{trades.length} fills · {openOptions.length} open options</span>} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price & the bot&apos;s trades</CardTitle>
          <CardDescription>Regular-session prices. Markers sit at the actual fill price; hover a bar for the details.</CardDescription>
        </CardHeader>
        <CardContent>
          <PriceChart symbol={symbol} ranges={charts} levels={levels} />
        </CardContent>
      </Card>

      {position && plan && (
        <Card>
          <CardHeader>
            <CardDescription>
              Current plan · {titleCase(plan.horizon)} · {titleCase(plan.setup)} · stop {price(plan.stop_loss)} · target {price(plan.take_profit)} · value{" "}
              {usd(Number(position.market_value))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{plan.thesis}</p>
            <p className="text-muted-foreground">Invalidation: {plan.invalidation}</p>
          </CardContent>
        </Card>
      )}

      {options.length > 0 && (
        <section>
          <SectionTitle>Options on {symbol}</SectionTitle>
          <div className="space-y-4">
            {openOptions.length > 0 && <OptionsTable positions={openOptions} />}
            {options.some((o) => o.status === "closed") && <OptionsTable positions={options.filter((o) => o.status === "closed")} closed />}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>Trades</SectionTitle>
        <TradesTable trades={trades} />
      </section>
      <section>
        <SectionTitle>Decisions</SectionTitle>
        <DecisionsTable decisions={decisions} showDay />
      </section>
    </div>
  )
}
