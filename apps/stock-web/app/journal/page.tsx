import type { Metadata } from "next"
import { PageHeader } from "@/components/bits"
import { DayRows } from "@/components/tables"
import { listDays } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Trading journal",
  description: "Day-by-day results of StockMarketBot, an AI trading bot by Colin Franceschini: daily profit and loss, every AI market report, decision and trade.",
  path: "/journal",
})

export default async function JournalPage() {
  return (
    <>
      <PageHeader title="Trading journal" description="One entry per trading day: the result, every cycle, report, decision and fill." />
      <DayRows days={await listDays()} />
    </>
  )
}
