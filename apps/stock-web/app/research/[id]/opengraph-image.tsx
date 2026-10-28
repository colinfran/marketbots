import { formatDay } from "@mb/stock-core/time"
import { getReportMeta } from "@/lib/queries"
import { titleCase } from "@/lib/format"
import { OG_SIZE, ogCard } from "@/lib/og"

export const alt = "StockMarketBot AI market report"
export const size = OG_SIZE
export const contentType = "image/png"

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const meta = await getReportMeta((await params).id).catch(() => null)
  if (!meta) return ogCard({ eyebrow: "AI market report", title: "An AI on its own GPUs that reads the news, then trades stocks and options with $10,000." })
  const headline = meta.report.headline.length > 110 ? `${meta.report.headline.slice(0, 109)}…` : meta.report.headline
  return ogCard({
    eyebrow: `${titleCase(meta.phase)} · ${formatDay(meta.trading_day)}`,
    title: headline,
    subtitle: `Market sentiment: ${titleCase(meta.report.market.sentiment)}`,
  })
}
