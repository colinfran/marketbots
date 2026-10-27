import { formatDay } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Delta, SectionTitle, Stat } from "@/components/bits"
import { CyclesList } from "@/components/report-view"
import { DecisionsTable, ReportList, TradesTable } from "@/components/tables"
import { collections } from "@/lib/db"
import { pct, usd } from "@/lib/format"
import { getDay } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

const DAY = /^\d{4}-\d{2}-\d{2}$/

export async function generateMetadata({ params }: { params: Promise<{ day: string }> }): Promise<Metadata> {
  const { day } = await params
  if (!DAY.test(day)) return { title: "Day not found", robots: { index: false } }
  const stats = await (await collections()).dailyStats.findOne({ _id: day }).catch(() => null)
  const result = stats ? `finished the day ${usd(stats.pnl, { sign: true })} (${pct(stats.pnl_pct)}) with ${stats.wins} winning and ${stats.losses} losing trades` : "trading day in progress"
  return pageMetadata({
    title: `Trading journal: ${formatDay(day)}`,
    description: `StockMarketBot's AI ${result} on ${formatDay(day)}. Every Grok market report, decision and trade from the session.`,
    path: `/journal/${day}`,
  })
}

export default async function DayPage({ params }: { params: Promise<{ day: string }> }) {
  const { day } = await params
  if (!DAY.test(day)) notFound()
  const { stats, cycles, reports, decisions, trades } = await getDay(day)
  const realized = trades.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0)

  return (
    <div className="space-y-8">
      <div>
        <Link href="/journal" className="text-muted-foreground text-sm hover:underline">
          ← Journal
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{formatDay(day)}</h1>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Day P&L"
          value={stats ? <Delta value={stats.pnl} className="text-2xl" /> : "In progress"}
          sub={
            stats && (
              <span className="inline-flex flex-wrap items-center gap-x-2">
                <Delta percent={stats.pnl_pct} />
                {stats.spy_pct != null && <span className="text-muted-foreground">SPY {pct(stats.spy_pct)}</span>}
              </span>
            )
          }
        />
        <Stat label="End equity" value={stats ? usd(stats.end_equity) : "—"} sub={stats && <span className="text-muted-foreground">started {usd(stats.start_equity)}</span>} />
        <Stat label="Realized" value={<Delta value={realized} className="text-2xl" />} sub={<span className="text-muted-foreground">{trades.length} fills</span>} />
        <Stat
          label="Wins / Losses"
          value={stats ? `${stats.wins} / ${stats.losses}` : "—"}
          sub={stats?.best && <span className="text-muted-foreground">best {stats.best.symbol} {usd(stats.best.pnl, { sign: true })}</span>}
        />
      </div>

      <section>
        <SectionTitle>Reports</SectionTitle>
        <ReportList reports={reports} showDay={false} />
      </section>
      <section>
        <SectionTitle>Decisions</SectionTitle>
        <DecisionsTable decisions={decisions} />
      </section>
      <section>
        <SectionTitle>Trades</SectionTitle>
        <TradesTable trades={trades} showDay={false} />
      </section>
      {cycles.length > 0 && (
        <section>
          <SectionTitle>Cycles</SectionTitle>
          <CyclesList cycles={cycles} />
        </section>
      )}
    </div>
  )
}
