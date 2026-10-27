import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { cache } from "react"
import { Delta, SectionTitle, Stat } from "@/components/bits"
import { ClosedPositionsTable, CyclesTable, DecisionsTable, FillsTable } from "@/components/tables"
import { getDay } from "@/lib/data"
import { formatDay, pct, usd } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

type Props = { params: Promise<{ day: string }> }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** One fetch per request, shared by the metadata and the page. */
const loadDay = cache(getDay)

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { day } = await params
  if (!DAY.test(day)) return { title: "Day not found", robots: { index: false } }
  const stats = (await loadDay(day).catch(() => null))?.stats
  const result = stats ? `finished the day ${usd(stats.pnl_usd, { sign: true })} (${pct(stats.pnl_pct)}) with ${stats.wins} winning and ${stats.losses} losing exits` : "day in progress"
  return pageMetadata({
    title: `Trading journal: ${formatDay(day)}`,
    description: `CryptoMarketBot's AI ${result} on ${formatDay(day)} (UTC). Every Grok research cycle, decision and trade from the day.`,
    path: `/journal/${day}`,
  })
}

export default async function DayPage({ params }: Props) {
  const { day } = await params
  if (!DAY.test(day)) notFound()
  const { stats, cycles, decisions, fills, closed } = await loadDay(day)
  const realized = fills.reduce((sum, f) => sum + (f.realized_pnl_usd ?? 0), 0)

  return (
    <div className="space-y-8">
      <div>
        <Link href="/journal" className="text-muted-foreground text-sm hover:underline">
          ← Journal
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{formatDay(day)}</h1>
        <p className="text-muted-foreground mt-1 text-sm">UTC day, midnight to midnight.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Day P&L" value={stats ? <Delta value={stats.pnl_usd} className="text-2xl" /> : "In progress"} sub={stats && <Delta percent={stats.pnl_pct} />} />
        <Stat label="End equity" value={stats ? usd(stats.end_equity_usd) : "—"} sub={stats && <span className="text-muted-foreground">started {usd(stats.start_equity_usd)}</span>} />
        <Stat label="Realized" value={<Delta value={realized} className="text-2xl" />} sub={<span className="text-muted-foreground">{fills.length} fills</span>} />
        <Stat
          label="Wins / Losses"
          value={stats ? `${stats.wins} / ${stats.losses}` : "—"}
          sub={stats && <span className="text-muted-foreground">fees {usd(stats.fees_usd)}</span>}
        />
      </div>

      <section>
        <SectionTitle>Research</SectionTitle>
        <CyclesTable cycles={cycles} />
      </section>
      <section>
        <SectionTitle>Decisions</SectionTitle>
        <DecisionsTable decisions={decisions} />
      </section>
      <section>
        <SectionTitle>Closed trades</SectionTitle>
        <ClosedPositionsTable positions={closed} />
      </section>
      <section>
        <SectionTitle>Fills</SectionTitle>
        <FillsTable fills={fills} />
      </section>
    </div>
  )
}
