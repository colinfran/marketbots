import { CORE_TOP_CANDIDATES } from "@mb/stock-core/core-book"
import { CORE_INDEX_ETFS, parseTheme, type Weekday } from "@mb/stock-core/settings"
import { formatDateTime, formatDay } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { Badge } from "@mb/ui/components/badge"
import { Empty, PageHeader, SectionTitle, Stat } from "@/components/bits"
import { getCoreRanking, getSettings } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"
import { RankingTable } from "./ranking-table"

export const metadata: Metadata = pageMetadata({
  title: "Core book: long-term holdings",
  description: "StockMarketBot's long-term core book: a share of the account in a handful of holdings with written theses, reviewed weekly, and the momentum ranking it picks from.",
  path: "/core",
})

const WEEKDAY: Record<Weekday, string> = { mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays" }

export default async function CorePage() {
  const [ranking, settings] = await Promise.all([getCoreRanking(), getSettings()])
  const c = settings.core
  const ranked = ranking?.rows.filter((r) => r.rank !== null) ?? []
  const unranked = ranking?.rows.filter((r) => r.rank === null) ?? []
  const themes = c.themes.map(parseTheme).filter((t) => t !== null)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Core book"
        description="A fixed share of the account in a handful of long-term holdings, each with a written reason and a written exit, reviewed every week instead of every 30 minutes. Day and swing trading run with the rest of the money. The yardstick is beating SPY over months."
        action={<Badge variant={c.enabled ? "default" : "secondary"}>{c.enabled ? "On" : "Off"}</Badge>}
      />
      {!c.enabled && (
        <p className="text-muted-foreground max-w-3xl text-sm">
          The core book is off: nothing trades on it yet. The ranking below is built every trading morning anyway, so its picks can be judged before the book starts.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Target" value={`${c.target_pct}% of equity`} sub={<span className="text-muted-foreground">rebalanced when off by more than {c.band_pct} points</span>} />
        <Stat label="Holdings" value={`${c.min_holdings}–${c.max_holdings}`} sub={<span className="text-muted-foreground">buys need conviction {c.min_conviction}/10 or more</span>} />
        <Stat
          label="Caps"
          value={`${c.max_holding_pct}% per stock`}
          sub={
            <span className="text-muted-foreground">
              {c.max_index_etf_pct}% per index ETF ({CORE_INDEX_ETFS.join(", ")}), {c.max_theme_pct}% of the book per theme
            </span>
          }
        />
        <Stat label="Review" value={`${WEEKDAY[c.review_weekday]} ${c.review_time_et} ET`} sub={<span className="text-muted-foreground">stops start {c.stop_pct}% below entry and only move up</span>} />
      </div>

      <section className="space-y-3">
        <SectionTitle>Ranking</SectionTitle>
        {!ranking ? (
          <Empty>No ranking yet: the engine builds one every trading morning, from the premarket briefing on.</Empty>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Built {formatDateTime(ranking.built_at)} from daily bars through {ranking.as_of ? formatDay(ranking.as_of) : "—"}. {ranked.length} of {ranking.rows.length} candidates pass the trend filter; the
              review sees the top {CORE_TOP_CANDIDATES}, every theme ticker and every holding.
            </p>
            {ranked.length ? <RankingTable rows={ranked} ranked /> : <Empty>No candidate passes the trend filter today.</Empty>}
            {unranked.length > 0 && (
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">Not ranked ({unranked.length})</summary>
                <RankingTable rows={unranked} ranked={false} />
              </details>
            )}
            {ranking.excluded.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Left out: {ranking.excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}.
              </p>
            )}
          </>
        )}
      </section>

      {themes.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Themes</SectionTitle>
          <ul className="space-y-1 text-sm">
            {themes.map((t) => (
              <li key={t.name}>
                <span className="font-medium">{t.name}</span>
                {t.tickers.length > 0 && <span className="text-muted-foreground">: {t.tickers.join(", ")}</span>}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">A theme is a reason to look, not an order: the review still has to make the case with current evidence, and no theme may hold more than {c.max_theme_pct}% of the book.</p>
        </section>
      )}

      <section className="text-muted-foreground max-w-3xl space-y-2 text-sm">
        <h2 className="text-foreground text-base font-semibold">How the ranking works</h2>
        <p>
          Every trading morning, code takes the {c.universe_size} most-traded liquid stocks and ETFs, the benchmark ETFs, every ticker in a theme and every holding, and reads a year of daily bars for each.
          Leveraged, inverse, volatility and option-income funds are left out. A name passes the trend filter when its price is above its 200-day average and its 50-day average is above the 200-day.
        </p>
        <p>
          The score ranks the names that pass, from 0 to 100: the average percentile of two momentum measures, the 12-month return without the last month and the 6-month return, each divided by the
          name&apos;s volatility (counted as at least 15%, about the market&apos;s), so a steady climb beats a wild one and a calm fund can&apos;t win on calm alone. The weekly review reads the theses behind the top names with live research before anything is bought; see{" "}
          <Link href="/strategies" className="text-foreground underline underline-offset-2">
            Strategies
          </Link>{" "}
          for the trading books.
        </p>
      </section>
    </div>
  )
}
