import { SETUP_INFO } from "@mb/stock-core/setups"
import type { Metadata } from "next"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, PageHeader, SectionTitle, Stat } from "@/components/bits"
import { getSettings, getSetupStats, type SetupTally } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Trading strategies and setups",
  description: "The day-trading, swing and options books StockMarketBot's AI trades, the setups it labels every trade with, and how each one has actually performed.",
  path: "/strategies",
})

const winRate = (t: SetupTally) => (t.closed ? `${Math.round((t.wins / t.closed) * 100)}%` : "—")

const BOOK_TEXT = {
  day: "Setups on the 5-minute chart (VWAP, opening range, intraday trend), flat by the close.",
  swing: "Setups on the daily chart (trend, 20/50-day levels, multi-day catalysts), held for days or weeks while the thesis holds.",
  options: "Defined-risk long calls and puts (and debit spreads when enabled): the most a position can lose is what was paid.",
} as const

export default async function StrategiesPage() {
  const [{ setups, books }, settings] = await Promise.all([getSetupStats(), getSettings()])
  return (
    <div className="space-y-8">
      <PageHeader
        title="Strategies"
        description="The AI runs three books and labels every new trade with one setup from a fixed list; the risk engine has the final word on each order. Each setup states why it should make money, so its results here can confirm or refute that."
      />
      <section>
        <SectionTitle>Books</SectionTitle>
        <div className="grid gap-3 md:grid-cols-3">
          {books.map((b) => (
            <Stat
              key={b.key}
              label={b.label}
              value={<Delta value={b.realized} className="text-2xl" />}
              sub={
                <div className="space-y-1">
                  <p className="text-muted-foreground">
                    {b.executed}/{b.entries} entries executed · {b.closed} closing trades · win rate {winRate(b)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {BOOK_TEXT[b.key]}
                    {b.key === "options" && !settings.options.enabled && " Currently turned off in settings."}
                  </p>
                </div>
              }
            />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Setups</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          {setups.map((s) => {
            const info = SETUP_INFO[s.key]
            return (
              <Card key={s.key}>
                <CardHeader>
                  <CardTitle className="text-base">{info.name}</CardTitle>
                  <CardDescription>{info.summary}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p>
                    <span className="font-medium">Why it should work: </span>
                    <span className="text-muted-foreground">{info.rationale}</span>
                  </p>
                  <p>
                    <span className="font-medium">AI&apos;s role: </span>
                    <span className="text-muted-foreground">{info.ai_role}</span>
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                    {s.entries ? (
                      <span className="text-muted-foreground text-xs">
                        {s.executed}/{s.entries} entries executed · {s.closed} closing trades · win rate {winRate(s)} · net <Delta value={s.realized} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Not traded yet.</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      <section className="text-muted-foreground max-w-3xl space-y-2 text-sm">
        <h2 className="text-foreground text-base font-semibold">How they&apos;re measured</h2>
        <p>
          A trade&apos;s realized P&L counts toward the setup and book of the decision that opened it, including stop-loss and take-profit exits the broker triggered. Setups
          aren&apos;t backtested: they are the AI&apos;s calls, and a model asked about past prices has probably seen what happened next. They are judged going forward instead,
          on these results and on{" "}
          <Link prefetch href="/analytics" className="text-foreground underline underline-offset-2">
            Analytics
          </Link>
          . Nothing changes automatically: the prompt and rules change only by hand.
        </p>
      </section>
    </div>
  )
}
