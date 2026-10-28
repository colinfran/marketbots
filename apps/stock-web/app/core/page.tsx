import { CORE_TOP_CANDIDATES } from "@mb/stock-core/core-book"
import { CORE_INDEX_ETFS, parseTheme } from "@mb/stock-core/settings"
import { formatDateTime, formatDay, marketDay } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, PageHeader, SectionTitle, Stat, SymbolLink } from "@/components/bits"
import { pct, price, usd, WEEKDAY_PLURAL } from "@/lib/format"
import { getBookDays, getCoreRanking, getLiveAccount, getSettings, listCoreReviews } from "@/lib/queries"
import { compound } from "@/lib/returns"
import { pageMetadata } from "@/lib/site"
import { RankingTable } from "./ranking-table"
import { ReviewCard } from "./review-card"

export const metadata: Metadata = pageMetadata({
  title: "Core book: long-term holdings",
  description: "StockMarketBot's long-term core book: a share of the account in a handful of holdings with written theses, reviewed weekly, against SPY, and the momentum ranking it picks from.",
  path: "/core",
})

export default async function CorePage() {
  const [ranking, settings, live, reviews, days] = await Promise.all([getCoreRanking(), getSettings(), getLiveAccount(), listCoreReviews(12), getBookDays()])
  const c = settings.core
  const ranked = ranking?.rows.filter((r) => r.rank !== null) ?? []
  const unranked = ranking?.rows.filter((r) => r.rank === null) ?? []
  const themes = c.themes.map(parseTheme).filter((t) => t !== null)
  const equity = live?.equity ?? 0
  const holdings = (live?.positions ?? []).filter((p) => p.plan?.book === "core").sort((a, b) => b.marketValue - a.marketValue)
  const value = holdings.reduce((s, p) => s + p.marketValue, 0)
  const share = (v: number) => (equity > 0 ? (v / equity) * 100 : null)
  const lastWeekly = reviews.find((r) => r.kind === "weekly" && !r.dry_run && r.status === "done")
  // Since the core book started: its days chained, against SPY's on the same days.
  const benchmarked = days.filter((d) => d.books?.core.pnl_pct != null && d.spy_pct != null)
  const coreReturn = compound(benchmarked.map((d) => d.books!.core.pnl_pct!))
  const spyReturn = compound(benchmarked.map((d) => d.spy_pct!))

  return (
    <div className="space-y-8">
      <PageHeader
        title="Core book"
        description="A fixed share of the account in a handful of long-term holdings, each with a written reason and a written exit, reviewed every week instead of every 30 minutes. Day and swing trading run with the rest of the money. The yardstick is beating SPY over months."
        action={<Badge variant={c.enabled ? "default" : "secondary"}>{c.enabled ? "On" : "Off"}</Badge>}
      />
      {!c.enabled && (
        <p className="text-muted-foreground max-w-3xl text-sm">
          The core book is off: nothing trades on it, and the trading cycles treat every position as their own. The ranking below is built every trading morning anyway, so its picks can be judged before the book starts.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Core book"
          value={usd(value)}
          sub={
            <span className="text-muted-foreground">
              {pct(share(value), { sign: false, digits: 1 })} of equity · target {c.target_pct}%
            </span>
          }
        />
        <Stat label="Holdings" value={holdings.length} sub={<span className="text-muted-foreground">between {c.min_holdings} and {c.max_holdings}</span>} />
        <Stat
          label="Since it started"
          value={<Delta percent={coreReturn} className="text-2xl" />}
          sub={<span className="text-muted-foreground">{benchmarked.length ? `SPY ${pct(spyReturn)} over the same ${benchmarked.length} day${benchmarked.length === 1 ? "" : "s"}` : "No completed day yet"}</span>}
        />
        <Stat
          label="Weekly review"
          value={`${WEEKDAY_PLURAL[c.review_weekday]} ${c.review_time_et} ET`}
          sub={<span className="text-muted-foreground">{lastWeekly ? `Last: ${formatDateTime(lastWeekly.created_at)}` : "None yet"}</span>}
        />
      </div>

      <section className="space-y-3">
        <SectionTitle>Holdings</SectionTitle>
        {holdings.length === 0 ? (
          <Empty>{c.enabled ? "No core holdings yet: the next weekly review builds the book." : "No core holdings."}</Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {holdings.map((p) => {
              const plan = p.plan!
              const stopGap = plan.stop_loss !== null && p.price > 0 ? (1 - plan.stop_loss / p.price) * 100 : null
              return (
                <Card key={p.symbol}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <SymbolLink symbol={p.symbol} />
                      {plan.theme && <Badge variant="secondary">{plan.theme}</Badge>}
                      <span className="text-muted-foreground ml-auto text-xs font-normal">{pct(share(p.marketValue), { sign: false, digits: 1 })} of equity</span>
                    </CardTitle>
                    <CardDescription>
                      Since {formatDay(marketDay(plan.opened_at))} · stop {price(plan.stop_loss)}
                      {stopGap !== null && ` (${pct(stopGap, { sign: false, digits: 1 })} below)`} · {plan.last_reviewed_at ? `reviewed ${formatDateTime(plan.last_reviewed_at)}` : "not reviewed yet"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p>{plan.thesis}</p>
                    <p>
                      <span className="font-medium">Invalidation:</span> <span className="text-muted-foreground">{plan.invalidation}</span>
                    </p>
                    {(plan.notes?.length ?? 0) > 0 && (
                      <ul className="text-muted-foreground space-y-0.5 border-t pt-2 text-xs">
                        {plan.notes!.slice(-3).map((n) => (
                          <li key={`${n.review_id}-${n.action}`}>
                            {formatDay(marketDay(n.at))}, {n.action}: {n.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="border-t pt-2 text-xs">
                      <Delta value={p.unrealizedPl} percent={p.unrealizedPlPct} /> <span className="text-muted-foreground">· {usd(p.marketValue)}</span>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>Reviews</SectionTitle>
        {reviews.length === 0 ? (
          <Empty>No reviews yet. Admin can run a dry run at any time: it researches, decides and shows the trades it would make, without placing any.</Empty>
        ) : (
          <div className="space-y-4">
            {reviews.map((r) => (
              <ReviewCard key={r._id} review={r} />
            ))}
          </div>
        )}
      </section>

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
        <h2 className="text-foreground text-base font-semibold">How it works</h2>
        <p>
          The book aims for {c.target_pct}% of equity in {c.min_holdings} to {c.max_holdings} holdings: at most {c.max_holding_pct}% in one stock, {c.max_index_etf_pct}% in a broad-index ETF ({CORE_INDEX_ETFS.join(", ")}) and{" "}
          {c.max_theme_pct}% of the book in one theme. Every {WEEKDAY_PLURAL[c.review_weekday].replace(/s$/, "")} at {c.review_time_et} ET, the AI researches each holding&apos;s thesis, the themes and the top of the
          ranking with live web search, then keeps, trims, sells or buys; code enforces the caps, the cash, at most {c.max_trades_per_review} trades and a conviction of {c.min_conviction}/10 for a buy.
          Serious bad news about a holding starts a review of that holding alone. Each holding rests on a stop at the broker that starts {c.stop_pct}% below entry and only moves up, with no profit
          target: winners run while the thesis holds. The trading cycles leave the book alone.
        </p>
        <p>
          Every trading morning, code takes the {c.universe_size} most-traded liquid stocks and ETFs, the benchmark ETFs, every ticker in a theme and every holding, and reads a year of daily bars for each.
          Leveraged, inverse, volatility and option-income funds are left out. A name passes the trend filter when its price is above its 200-day average and its 50-day average is above the 200-day. The
          score ranks the names that pass, from 0 to 100: the average percentile of two momentum measures, the 12-month return without the last month and the 6-month return, each divided by the
          name&apos;s volatility (counted as at least 15%, about the market&apos;s), so a steady climb beats a wild one and a calm fund can&apos;t win on calm alone. See{" "}
          <Link href="/strategies" className="text-foreground underline underline-offset-2">
            Strategies
          </Link>{" "}
          for the trading books.
        </p>
      </section>
    </div>
  )
}
