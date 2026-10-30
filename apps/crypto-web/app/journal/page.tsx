import type { Metadata } from "next"
import { PageHeader } from "@/components/bits"
import { DayRows } from "@/components/tables"
import { getDays } from "@/lib/data"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Trading journal",
  description: "Day-by-day results of CryptoMarketBot, an AI crypto trading bot by Colin Franceschini: daily profit and loss, every episode of the AI agent, decision and trade.",
  path: "/journal",
})

export default async function JournalPage() {
  return (
    <div>
      <PageHeader title="Trading journal" description="One entry per UTC day: the result, every episode of the agent, decision and fill." />
      <DayRows days={await getDays()} />
    </div>
  )
}
