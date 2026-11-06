import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@mb/crypto-core/settings"
import type { Metadata } from "next"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { PageHeader } from "@/components/bits"
import { getSettings } from "@/lib/data"
import { num, usd } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "How the AI crypto trading bot works",
  description:
    "How CryptoMarketBot works: an AI agent on an open-weight model on our own server watches crypto news and prices, looks things up, decides, and trades a Kraken paper wallet 24/7 with risk rules enforced in code. Built by Colin Franceschini.",
  path: "/about",
})

/** 240 → "4 h", 90 → "90 min". */
const minutes = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${num(m, 1)} min`)

/** What wakes the agent, and what runs without it. */
const wakes = (s: Settings) => [
  {
    title: "The news",
    when: "Around the clock",
    body: "The bot's own news engine reads about 70 sources: news outlets, regulators, exchanges and calendars. Bad news on a coin it holds wakes the agent before anything else; an idea for a new trade needs a second source to confirm it.",
  },
  {
    title: "The screens",
    when: "As each minute's bars arrive",
    body: "Live Kraken order books and candles become features in code: trend, RSI, ATR, Bollinger bands, volatility, market regime and correlations. Trend-following, mean-reversion, relative-strength and event-driven screens run on them, and the five best setups on coins it doesn't hold wake the agent together.",
  },
  {
    title: "Sharp moves and quiet time",
    when: `On a ${num(s.schedule.trigger_move_atr, 1)} ATR move, or after ${minutes(s.agent.sweep_minutes)} of quiet`,
    body: "A held coin moving sharply wakes it at once, a drop before anything else. So do its own watches (a price, a move, news, a time) and a macro release coming up. When nothing has woken it for a while, it reviews the whole book anyway.",
  },
  {
    title: "Stops and targets",
    when: "Every 3 seconds",
    body: "The engine checks every position against the live order book and exits at its stop or target. This runs whether or not the agent is working or the engine is paused.",
  },
]

const rules = (s: Settings) => {
  const k = s.kraken
  const p = s.portfolio
  const e = s.agent.envelope
  return [
    `Starts with ${usd(s.paper.starting_usd, { whole: true })} of simulated money in a Kraken CLI paper wallet, filled at live Kraken prices with a ${num(k.taker_fee_bps)} bps fee and ${num(k.paper_slippage_bps)} bps slippage. Spot only: no leverage, no shorting.`,
    `Each trade risks ${num(k.risk_per_trade_pct)}% of equity if its stop is hit. Stops sit ${num(k.min_stop_pct)}–${num(k.max_stop_pct)}% below entry, and the target must offer at least ${num(k.min_reward_risk)}:1 reward to risk.`,
    `At most ${num(k.max_position_pct)}% of equity per new position, ${num(k.max_asset_exposure_pct)}% in one coin, ${num(k.max_total_exposure_pct)}% invested in total and ${num(k.max_correlated_exposure_pct)}% across coins that move together. ${k.max_concurrent_positions} positions at once and ${k.max_trades_per_day} trades a day.`,
    `Code keeps only ${num(s.ai.probability_shrink * 100, 0)}% of the edge the AI claims, then subtracts fees, spread and slippage walked through the real order book. A trade needs ${num(k.min_edge_bps)} bps of expected edge left over and ${num(k.min_conviction)}/100 conviction.`,
    `No entries on quotes older than ${num(k.max_quote_age_seconds)} s or spreads wider than ${num(k.max_spread_bps)} bps, and no re-buying a coin within ${minutes(k.reentry_cooldown_minutes)} of selling it. The AI can't close a position younger than ${minutes(k.min_hold_minutes)} unless its stop or invalidation hits, and stops only ever move up.`,
    `The agent has limits of its own: ${e.entries_per_day} new entries a day and ${e.entries_per_hour} an hour, ${e.max_open_positions} open positions it opened, at most 3 new coins per wake-up, no entry in a coin it acted on in the last ${minutes(e.symbol_action_minutes)}, and no re-entry within ${num(e.reentry_after_stop_hours)} h of a stop-out or ${num(e.flip_hours)} h of a sale. Each entry is sized at ${num(e.size_pct)}% of what the rules above allow, and an hour's entries can't commit more than ${num(e.commit_per_hour_pct)}% of equity.`,
    `A day down ${num(p.max_daily_loss_pct)}% blocks new entries until the next UTC day. A ${num(p.max_drawdown_pct)}% drawdown from peak equity engages the kill switch${p.drawdown_action === "halt_and_liquidate" ? " and sells everything" : ""}.`,
    "Circuit breakers are for extreme cases: the wallet 20% below its peak since the agent took over (or was last resumed) pauses new entries until the owner resumes them. A slow model, or most of its answers in an hour invalid, pauses the agent's entries only while it lasts. Exits carry on either way, and a rule refusing an order trips nothing.",
    "Stale data or an invalid answer means no trade.",
    "The AI can't change any of this: settings change only through audited owner commands. Every episode (each step, what it looked up and its answer), decision (including no-trades and rejected orders), risk check, order and fill is stored and shown on this site.",
  ]
}

export default async function AboutPage() {
  const parsed = settingsSchema.safeParse((await getSettings().catch(() => null))?.settings)
  const s = parsed.success ? parsed.data : DEFAULT_SETTINGS
  const l = s.agent.limits
  return (
    <div className="space-y-8">
      <PageHeader
        title="How it works"
        description="An experiment in whether an AI agent running on our own hardware, woken by the news and the market as they move, can trade crypto profitably, 24/7, after fees, with a risk engine that has the final word."
      />
      {s.agent.level !== "on" && (
        <p className="text-muted-foreground rounded-lg border px-4 py-3 text-sm leading-relaxed">
          Right now the agent isn&apos;t trading: it&apos;s switched off until the owner turns it back on.
        </p>
      )}
      <section className="grid gap-3 sm:grid-cols-2">
        {wakes(s).map((step, i) => (
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
        <h2 className="mb-3 text-base font-semibold">Each wake-up is an episode</h2>
        <p className="text-muted-foreground mb-3 text-sm leading-relaxed">
          The agent runs on an open-weight model ({s.agent.model}) on two graphics cards in the server that runs the bot: no AI service and no per-call cost. One
          episode runs at a time, and bad news on a holding interrupts anything else. Each one streams to the{" "}
          <Link href="/agent" className="text-foreground underline underline-offset-2">
            Agent
          </Link>{" "}
          page as it happens.
        </p>
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            <span className="text-foreground font-medium">The brief</span>: why it woke, its holdings and the limits in force, the market, and the latest news on each
            coin it woke for, with the notes and watches it left itself.
          </li>
          <li>
            <span className="text-foreground font-medium">Lookups</span>, one step at a time from 11 read-only tools: its book, quotes, features, order-book depth,
            news, a coin&apos;s news dossier, past decisions, the macro calendar, and years of prices and past news from our history store. It can&apos;t search the
            web or place an order from here.
          </li>
          <li>
            <span className="text-foreground font-medium">The answer</span>: one structured decision per coin (action, conviction, the odds of hitting the target
            before the stop, stop and target, bull and bear evidence, risks and what would prove it wrong), plus watches and notes for later. Exits go first, then
            entries pass its own limits and the risk engine.
          </li>
        </ol>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          Urgent wake-ups get {l.p0.steps} steps and {num(l.p0.seconds)} s; reviews get up to {l.p2.steps} steps and {minutes(l.p2.seconds / 60)}, with time to think.
        </p>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Rules enforced in code</h2>
        <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-relaxed">
          {rules(s).map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Is there an edge?</h2>
        <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            The agent can&apos;t be backtested: a model asked about past prices has probably seen what happened next.
          </li>
          <li>
            So the AI is judged going forward: every decision, including the trades it passed on, is scored against what the price actually did.{" "}
            <Link href="/analytics" className="text-foreground underline underline-offset-2">
              Analytics
            </Link>{" "}
            compares what it bought with what it skipped, with the screens alone and with a random-walk baseline, and checks how well calibrated its odds are.
          </li>
          <li>
            Nothing learns automatically. The agent&apos;s notes to itself expire after 14 days; strategies and prompts change only by hand, and every decision records
            the model and prompt version it used.
          </li>
        </ul>
      </section>
      <section>
        <h2 className="mb-3 text-base font-semibold">Sister project</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          There&apos;s a stock-market version of this experiment:{" "}
          <a href="https://stockmarketbot.app" className="text-foreground underline underline-offset-2">
            StockMarketBot
          </a>{" "}
          runs the same idea on US stocks and defined-risk options with a $10,000 paper account.
        </p>
      </section>
    </div>
  )
}
