import type { Metadata } from "next"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { Delta, PageHeader, PaperBadge, Stat } from "@/components/bits"
import { TradesTable } from "@/components/tables"
import { listTrades } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"
import { OptionsTab } from "./options-tab"

export const metadata: Metadata = pageMetadata({
  title: "Trade history",
  description:
    "Every stock and options trade made by StockMarketBot's AI: closing trades with realized profit and loss, win rate, every fill, and every defined-risk options position.",
  path: "/trades",
})

const TABS = ["closed", "fills", "options"] as const

export default async function TradesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams
  const trades = await listTrades(5000)
  const closed = trades.filter((t) => t.realized_pnl !== null)
  const realized = closed.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0)
  const wins = closed.filter((t) => (t.realized_pnl ?? 0) > 0)
  const losses = closed.filter((t) => (t.realized_pnl ?? 0) < 0)
  const avg = (xs: typeof closed) => (xs.length ? xs.reduce((s, t) => s + (t.realized_pnl ?? 0), 0) / xs.length : null)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trades"
        description={
          <>
            Every fill, stocks and option legs, including stop-loss and take-profit exits the broker triggered on its own. Realized P&L uses first-in, first-out lots (options ×
            100 per contract). What the bot holds now is on{" "}
            <Link href="/holdings" className="text-foreground underline underline-offset-2">
              Holdings
            </Link>
            .
          </>
        }
        action={<PaperBadge className="text-sm" />}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Realized P&L" value={<Delta value={realized} className="text-2xl" />} />
        <Stat label="Closed trades" value={closed.length} sub={<span className="text-muted-foreground">{trades.length} fills total</span>} />
        <Stat
          label="Win rate"
          value={closed.length ? `${Math.round((wins.length / closed.length) * 100)}%` : "—"}
          sub={
            <span className="text-muted-foreground">
              {wins.length} wins · {losses.length} losses
            </span>
          }
        />
        <Stat
          label="Avg win / avg loss"
          value={
            <span className="text-lg">
              <Delta value={avg(wins)} /> / <Delta value={avg(losses)} />
            </span>
          }
        />
      </div>
      <Tabs defaultValue={TABS.find((t) => t === tab) ?? "closed"}>
        <TabsList>
          <TabsTrigger value="closed">Closed trades</TabsTrigger>
          <TabsTrigger value="fills">Fills</TabsTrigger>
          <TabsTrigger value="options">Options</TabsTrigger>
        </TabsList>
        <TabsContent value="closed" className="mt-4">
          <TradesTable trades={closed.slice(0, 500)} />
        </TabsContent>
        <TabsContent value="fills" className="mt-4">
          <TradesTable trades={trades.slice(0, 500)} />
        </TabsContent>
        <TabsContent value="options" className="mt-4">
          <OptionsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
