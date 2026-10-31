import type { Metadata } from "next"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { Delta, PageHeader, PaperBadge, Stat } from "@/components/bits"
import { ClosedPositionsTable, FillsTable, OrdersTable } from "@/components/tables"
import { getClosedPositions, getFills, getOrders, getRealizedSummary } from "@/lib/data"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Trade history",
  description: "Every closed trade, order and fill the AI crypto trading bot has made in its Kraken paper wallet, with realized P&L after fees and its win rate.",
  path: "/trades",
})

const TABS = ["closed", "fills", "orders"] as const

export default async function TradesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams
  const [summary, closed, orders, fills] = await Promise.all([getRealizedSummary(), getClosedPositions(100), getOrders(150), getFills(200)])
  return (
    <div className="space-y-8">
      <PageHeader
        title="Trades"
        description={
          <>
            Every order executes as a market order in the Kraken CLI paper wallet, behind the engine&apos;s pre-trade price guard. Realized P&L is after the fees on
            both legs. What the bot holds now is on{" "}
            <Link prefetch href="/holdings" className="text-foreground underline underline-offset-2">
              Holdings
            </Link>
            .
          </>
        }
        action={<PaperBadge className="text-sm" />}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Realized P&L" value={<Delta value={summary.realized} className="text-2xl" />} />
        <Stat label="Closed trades" value={summary.trades} sub={<span className="text-muted-foreground">{summary.fills} fills total</span>} />
        <Stat
          label="Win rate"
          value={summary.trades ? `${Math.round((summary.wins / summary.trades) * 100)}%` : "—"}
          sub={
            <span className="text-muted-foreground">
              {summary.wins} wins · {summary.losses} losses
            </span>
          }
        />
        <Stat
          label="Avg win / avg loss"
          value={
            <span className="text-lg">
              <Delta value={summary.avgWin} /> / <Delta value={summary.avgLoss} />
            </span>
          }
        />
      </div>
      <Tabs defaultValue={TABS.find((t) => t === tab) ?? "closed"}>
        <TabsList>
          <TabsTrigger value="closed">Closed trades</TabsTrigger>
          <TabsTrigger value="fills">Fills</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
        </TabsList>
        <TabsContent value="closed" className="mt-4">
          <ClosedPositionsTable positions={closed} />
        </TabsContent>
        <TabsContent value="fills" className="mt-4">
          <FillsTable fills={fills} />
        </TabsContent>
        <TabsContent value="orders" className="mt-4">
          <OrdersTable orders={orders} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
