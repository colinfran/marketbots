import { getDecision } from "@/lib/data"
import { dateTime, titleCase } from "@/lib/format"
import { OG_SIZE, ogCard } from "@/lib/og"
import { clip } from "@/lib/site"

export const alt = "CryptoMarketBot AI trade decision"
export const size = OG_SIZE
export const contentType = "image/png"

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const data = await getDecision((await params).id).catch(() => null)
  if (!data) return ogCard({ eyebrow: "AI trade decision", title: "An AI that researches crypto on the web and X, then trades around the clock." })
  const d = data.decision
  return ogCard({
    eyebrow: `AI trade decision · ${dateTime(d.created_at)}`,
    title: `${d.symbol}: ${titleCase(d.action)}`,
    subtitle: clip(d.ai.thesis, 180),
  })
}
