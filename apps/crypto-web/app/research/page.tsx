import type { Metadata } from "next"
import Link from "next/link"
import { PageHeader, SectionTitle } from "@/components/bits"
import { CyclesTable, DecisionsTable } from "@/components/tables"
import { getCycles, getDecisions } from "@/lib/data"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "AI research & decisions",
  description: "Every AI research cycle on crypto with live web search, and the evidence and reasoning behind every buy, hold, reduce or close decision.",
  path: "/research",
})

export default async function ResearchPage() {
  const [cycles, decisions] = await Promise.all([getCycles(40), getDecisions({ limit: 60 })])
  return (
    <div className="space-y-8">
      <PageHeader
        title="AI research & decisions"
        description={
          <>
            Every cycle the AI ran: it searches the web live, writes a sourced memo, then decides on each candidate and open position, and the risk engine approves,
            resizes or rejects every proposal. What the bot&apos;s own news engine sees is on{" "}
            <Link href="/news" className="text-foreground underline underline-offset-2">
              News
            </Link>
            .
          </>
        }
      />
      <section>
        <SectionTitle>Cycles</SectionTitle>
        <CyclesTable cycles={cycles} />
      </section>
      <section>
        <SectionTitle>Recent decisions (including no-trades)</SectionTitle>
        <DecisionsTable decisions={decisions} />
      </section>
    </div>
  )
}
