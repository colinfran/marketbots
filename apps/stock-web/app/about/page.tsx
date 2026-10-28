import type { Metadata } from "next"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { PageHeader } from "@/components/bits"
import { usd } from "@/lib/format"
import { getSettings } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "How the AI trading bot works",
  description:
    "How StockMarketBot works: an open-weight AI model on our own server researches the web, decides, and trades stocks and defined-risk options with a $10,000 paper account, with every risk rule enforced in code and every step streamed live. Built by Colin Franceschini.",
  path: "/about",
})

export default async function AboutPage() {
  const settings = await getSettings()
  const r = settings.risk
  const s = settings.schedule
  const o = settings.options

  const day = [
    {
      title: "Premarket briefing",
      when: `Up to ${s.premarket_lead_minutes} min before the open`,
      body: "The AI searches the web for overnight news, futures, the economic calendar, earnings and premarket gappers, then writes the day's game plan and watchlist. No orders.",
    },
    {
      title: "Intraday cycles",
      when: `Every ${s.trade_interval_minutes} min, from ${s.open_buffer_minutes} min after the open`,
      body: `Fresh research on what changed, plus live broker prices, VWAP, RSI, trend, opening range and option chains. The AI reviews every position, then buys, sells, adjusts exits, holds or trades options. A held stock moving ${s.trigger_move_pct}% between cycles triggers an extra cycle.`,
    },
    {
      title: "Closing cycle",
      when: `${s.close_window_minutes} min before the bell`,
      body: "Locks in the day: intraday stock trades are closed. Only profitable, high-conviction stock positions with no event risk are carried overnight.",
    },
    {
      title: "Postmarket review",
      when: `${s.postmarket_delay_minutes} min after the bell`,
      body: "An honest review of what worked and what didn't. The lessons are fed into every cycle for the next several days.",
    },
  ]

  const rules = [
    `Starts with ${usd(settings.account.starting_capital, { whole: true })} of fake money (an Alpaca paper account). Stocks are long only, with no margin.`,
    `At most ${r.max_position_pct}% of equity per stock, ${r.max_open_positions} stock positions at once and ${r.max_new_buys_per_cycle} new buys per cycle. ${r.cash_reserve_pct}% is always kept in cash.`,
    `Every stock buy is a bracket order with a stop-loss and a take-profit held by the broker, so exits fire even if the engine is down. Minimum reward:risk is ${r.min_reward_risk}.`,
    `Day P&L of −${r.max_daily_loss_pct}% blocks new buys. At −${r.flatten_loss_pct}% everything is liquidated. At +${r.profit_lock_pct}% position sizes are halved to protect the green day.`,
    `Never adds to a position or averages down, and a position's stop only ever moves up. No re-buying a stock within ${r.rebuy_cooldown_minutes} minutes of selling it, including when a stop-loss fired. Price must be at least $${r.min_price}.`,
    `After the closing cycle, intraday stock trades are sold and at most ${r.max_overnight_pct}% of equity is carried overnight in stocks.`,
    `Options are defined risk only (long calls, long puts${o.allow_spreads ? ", debit spreads" : ""}): at most ${o.max_premium_per_trade_pct}% of equity per position and ${o.max_total_premium_pct}% in total, ${o.max_open_positions} positions at once, closed ${o.close_at_dte} day${o.close_at_dte === 1 ? "" : "s"} before expiration.`,
    "Every cycle, report, decision (including rejected ones, with every rule that was checked), order and fill is stored, along with the exact market data the AI saw.",
  ]

  return (
    <div className="space-y-8">
      <PageHeader title="How it works" description="An experiment in whether an AI running on our own hardware, reading the news as it breaks, can finish every trading day green." />
      <section className="grid gap-3 sm:grid-cols-2">
        {day.map((step, i) => (
          <Card key={step.title} className="gap-2">
            <CardHeader>
              <p className="text-muted-foreground text-xs">
                {i + 1}. {step.when}
              </p>
              <CardTitle className="text-base">{step.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm leading-relaxed">{step.body}</CardContent>
          </Card>
        ))}
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Each cycle makes two AI calls, and you can watch both</h2>
        <p className="text-muted-foreground mb-3 text-sm leading-relaxed">
          Both run on an open-weight model on two graphics cards in the server that runs the bot (its name is shown with each call): no AI service and no
          per-call cost.
        </p>
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            <span className="text-foreground font-medium">Research</span> ({settings.ai.models.research}): the model writes web searches, our own search engine runs them, and it reads the most relevant articles in full. It then writes a sourced memo with timestamps. It doesn&apos;t decide anything here.
            Every search query and source streams to the <Link href="/" className="underline underline-offset-2">Live</Link> page as it happens.
          </li>
          <li>
            <span className="text-foreground font-medium">Decision</span> ({settings.ai.models.decision}): the memo, the broker&apos;s ground-truth data, the option chains and the risk limits become one fixed JSON
            structure: market read, catalysts, watchlist, decisions, risks and lessons. It streams as it&apos;s written, is validated, and is retried if invalid. Then the risk engine checks every decision
            in code and every check is shown.
          </li>
        </ol>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Rules enforced in code</h2>
        <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-relaxed">
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">How it runs</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          A trading engine runs around the clock in Docker on a dedicated server. It holds the only Alpaca keys, streams prices and fills from Alpaca over WebSockets, runs the schedule, asks the AI model
          running on the same server&apos;s graphics cards, places orders, and writes everything to MongoDB. This website reads MongoDB and opens a WebSocket to the engine for the live feed. It never trades; the
          owner&apos;s controls (pause, kill switch, settings) go through MongoDB as audited commands.
        </p>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Sister project</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          There&apos;s a crypto version of this experiment:{" "}
          <a href="https://cryptomarketbot.app" className="text-foreground underline underline-offset-2">
            CryptoMarketBot
          </a>{" "}
          runs the same idea on crypto, trading a Kraken paper wallet 24/7.
        </p>
      </section>
    </div>
  )
}
