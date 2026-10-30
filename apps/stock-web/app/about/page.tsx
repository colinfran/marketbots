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
    "How StockMarketBot works: an AI agent on an open-weight model on our own server watches the news and the market, looks things up, decides, and trades stocks and defined-risk options with a $10,000 paper account, with every risk rule enforced in code and every step streamed live. Built by Colin Franceschini.",
  path: "/about",
})

export default async function AboutPage() {
  const settings = await getSettings()
  const r = settings.risk
  const s = settings.schedule
  const o = settings.options
  const a = settings.agent
  const e = a.envelope

  const day = [
    {
      title: "Premarket plan",
      when: `Up to ${s.premarket_lead_minutes} min before the open`,
      body: "The agent wakes to plan the day: it reads the overnight news, looks things up and leaves itself watches and notes. No orders before the open.",
    },
    {
      title: "During the session",
      when: `From ${s.open_buffer_minutes} min after the open`,
      body: `Code watches every minute's bars and wakes the agent for setups: a break above the opening range or, an hour in, a new session high, each on at least twice the stock's usual volume. Breaking news, a held stock moving ${s.trigger_move_pct}%, a stop or target filling and its own watches wake it too, and after ${a.sweep_minutes / 60} h of quiet it reviews the book anyway. It trades stocks and options.`,
    },
    {
      title: "Closing window",
      when: `${s.close_window_minutes} min before the bell`,
      body: "If it holds anything, the agent reviews the book for the close; new buys now must be meant to last overnight, with conviction 8 or more. In the last 7 minutes, code sells the intraday stock trades and carries only profitable, high-conviction positions with no event risk.",
    },
    {
      title: "After the close",
      when: `${s.postmarket_delay_minutes} min after the bell`,
      body: "The agent reviews the day's decisions and its book, and leaves itself notes and watches for tomorrow.",
    },
  ]

  const rules = [
    `Starts with ${usd(settings.account.starting_capital, { whole: true })} of fake money (an Alpaca paper account). Stocks are long only, with no margin.`,
    `At most ${r.max_position_pct}% of equity per stock and ${r.max_open_positions} stock positions at once. ${r.cash_reserve_pct}% is always kept in cash.`,
    `Every stock buy is a bracket order with a stop-loss and a take-profit held by the broker, so exits fire even if the engine is down. Minimum reward:risk is ${r.min_reward_risk}.`,
    `Day P&L of −${r.max_daily_loss_pct}% blocks new buys. At −${r.flatten_loss_pct}% everything is liquidated. At +${r.profit_lock_pct}% position sizes are halved to protect the green day.`,
    `Never adds to a position or averages down, and a position's stop only ever moves up. No re-buying a stock within ${r.rebuy_cooldown_minutes} minutes of selling it, including when a stop-loss fired. Price must be at least $${r.min_price}.`,
    `In the last 7 minutes of the session, intraday stock trades are sold and at most ${r.max_overnight_pct}% of equity is carried overnight in stocks.`,
    `Options are defined risk only (long calls, long puts${o.allow_spreads ? ", debit spreads" : ""}): at most ${o.max_premium_per_trade_pct}% of equity per position and ${o.max_total_premium_pct}% in total, ${o.max_open_positions} positions at once, closed ${o.close_at_dte} day${o.close_at_dte === 1 ? "" : "s"} before expiration. An options trade must use a contract from a chain the agent loaded in the same episode.`,
    `The agent has limits of its own: ${e.entries_per_day} new entries a day and ${e.entries_per_hour} an hour, ${e.max_open_positions} open positions it opened, at most 3 new entries per wake-up, no entry in a stock it acted on in the last ${e.symbol_action_minutes} minutes, and no re-entry within ${e.reentry_after_stop_hours} h of a stop-out or ${e.flip_hours} h of a sale. Each entry is sized at ${e.size_pct}% of what the rules above allow, and an hour's entries can't commit more than ${e.commit_per_hour_pct}% of equity.`,
    "Circuit breakers take trading away from the agent: 5 entries in a row rejected by the risk checks, most entries rejected in an hour, over 10% invalid answers, its own limits refusing 3 entries in a day, or the account down 3% in a day or 6% since the agent took over. Positions keep their stops, and only the owner can put it back in charge. A slow model only pauses its entries.",
    "Every episode (each step, with the exact data each lookup returned, and its answer), decision (including rejected ones, with every rule that was checked), order and fill is stored.",
  ]

  return (
    <div className="space-y-8">
      <PageHeader title="How it works" description="An experiment in whether an AI agent running on our own hardware, woken by the news and the market as they move, can finish every trading day green." />
      {a.level !== "on" && (
        <p className="text-muted-foreground rounded-lg border px-4 py-3 text-sm leading-relaxed">
          Right now the agent isn&apos;t trading: it&apos;s switched off until the owner turns it back on.
        </p>
      )}
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
        <h2 className="mb-3 text-base font-semibold">Each wake-up is an episode, and you can watch it</h2>
        <p className="text-muted-foreground mb-3 text-sm leading-relaxed">
          The agent runs on an open-weight model ({a.model}) on two graphics cards in the server that runs the bot: no AI service and no per-call cost. One episode
          runs at a time, and bad news on a holding interrupts anything else. Every step streams to the{" "}
          <Link href="/agent" className="underline underline-offset-2">
            Agent
          </Link>{" "}
          page as it happens.
        </p>
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            <span className="text-foreground font-medium">The brief</span>: why it woke, its book, the session and the limits in force, the benchmarks, and the latest
            news on each stock it woke for, with the notes and watches it left itself.
          </li>
          <li>
            <span className="text-foreground font-medium">Lookups</span>, one step at a time from 11 read-only tools: its book, quotes, technicals from Alpaca&apos;s daily
            and 5-minute bars, option chains, news, a stock&apos;s news dossier, past decisions, the calendar, and years of prices and past news from our history store.
            It can&apos;t search the web or place an order from here.
          </li>
          <li>
            <span className="text-foreground font-medium">The answer</span>: its decisions in one fixed JSON structure (buy, sell, adjust exits or hold a stock; buy,
            close or hold an option), plus watches and notes for later. Sales go first, then the risk engine checks every decision in code and every check is shown.
          </li>
        </ol>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          Urgent wake-ups get {a.limits.p0.steps} steps and {a.limits.p0.seconds} s; the review after the close gets up to {a.limits.p3.steps} steps and{" "}
          {a.limits.p3.seconds / 60} min, with time to think.
        </p>
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
          A trading engine runs around the clock in Docker on a dedicated server. It holds the only Alpaca keys, streams prices and fills from Alpaca over WebSockets, watches the news and the market,
          wakes the agent on the AI model running on the same server&apos;s graphics cards, places orders, and writes everything to MongoDB. This website reads MongoDB and opens a WebSocket to the engine for the live feed. It never trades; the
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
