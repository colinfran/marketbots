import type { Metadata } from "next"
import Link from "next/link"
import { PageHeader, SectionTitle } from "@/components/bits"
import { DecisionsTable, ReportList } from "@/components/tables"
import { listRecentDecisions, listReports } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "AI research & market reports",
  description:
    "Every stock market report written by Grok for StockMarketBot: premarket briefings, intraday trading cycles, closing calls and postmarket reviews, sourced from the web and X and from the bot's own news engine, with every decision.",
  path: "/research",
})

export default async function ResearchPage() {
  const [reports, decisions] = await Promise.all([listReports(200), listRecentDecisions(60)])
  return (
    <div className="space-y-8">
      <PageHeader
        title="AI research & reports"
        description={
          <>
            Grok searches the web and X live, then writes one structured report per cycle: the market read, catalysts, a watchlist and a decision per idea and open position.
            The risk engine checks every decision in code. What the bot&apos;s own news engine sees is on{" "}
            <Link href="/news" className="text-foreground underline underline-offset-2">
              News
            </Link>
            .
          </>
        }
      />
      <section>
        <SectionTitle>Reports</SectionTitle>
        <ReportList reports={reports} />
      </section>
      <section>
        <SectionTitle>Recent decisions (including holds and rejections)</SectionTitle>
        <DecisionsTable decisions={decisions} showDay />
      </section>
    </div>
  )
}
