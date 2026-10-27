import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@mb/crypto-core/settings"
import type { Metadata } from "next"
import Link from "next/link"
import { PageHeader } from "@/components/bits"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getSettings } from "@/lib/data"
import { num, usd } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "How the AI crypto trading bot works",
  description:
    "How CryptoMarketBot works: Grok researches crypto on the web and X, decides, and trades a Kraken paper wallet 24/7 with risk rules enforced in code. Built by Colin Franceschini.",
  path: "/about",
})

/** 240 → "4 h", 90 → "90 min". */
const minutes = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${num(m, 1)} min`)

const cycle = (s: Settings) => [
  {
    title: "Quant screens",
    when: `Every ${minutes(s.schedule.crypto_scan_minutes)}, around the clock`,
    body: `Live Kraken order books and candles become features in code: trend, RSI, ATR, Bollinger bands, volatility, market regime and correlations. Trend-following, mean-reversion, relative-strength and event-driven screens propose up to ${s.ai.max_candidates_per_cycle} candidates. Nothing to decide means no AI call.`,
  },
  {
    title: "Position reviews",
    when: `Every ${minutes(s.schedule.position_review_minutes)}, or on a ${num(s.schedule.trigger_move_atr, 1)} ATR move`,
    body: "Every open position is reassessed with fresh research: hold (and raise the stop or move the target), reduce or close. A sharp move in a held coin triggers a review early.",
  },
  {
    title: "Stops and targets",
    when: "Every 3 seconds",
    body: "The engine checks every position against the live order book and exits at its stop or target. This runs whether or not the AI is working, the engine is paused, or the daily budget is spent.",
  },
  {
    title: "Scoring",
    when: "After each decision's horizon",
    body: "Every decision, including the trades it passed on, is scored against what the price actually did, and compared with the quant screen alone and a random-walk baseline.",
  },
]

const rules = (s: Settings) => {
  const k = s.kraken
  const p = s.portfolio
  return [
    `Starts with ${usd(s.paper.starting_usd, { whole: true })} of simulated money in a Kraken CLI paper wallet, filled at live Kraken prices with a ${num(k.taker_fee_bps)} bps fee and ${num(k.paper_slippage_bps)} bps slippage. Spot only: no leverage, no shorting.`,
    `Each trade risks ${num(k.risk_per_trade_pct)}% of equity if its stop is hit. Stops sit ${num(k.min_stop_pct)}–${num(k.max_stop_pct)}% below entry, and the target must offer at least ${num(k.min_reward_risk)}:1 reward to risk.`,
    `At most ${num(k.max_position_pct)}% of equity per new position, ${num(k.max_asset_exposure_pct)}% in one coin, ${num(k.max_total_exposure_pct)}% invested in total and ${num(k.max_correlated_exposure_pct)}% across coins that move together. ${k.max_concurrent_positions} positions at once and ${k.max_trades_per_day} trades a day.`,
    `Code keeps only ${num(s.ai.probability_shrink * 100, 0)}% of the edge the AI claims, then subtracts fees, spread and slippage walked through the real order book. A trade needs ${num(k.min_edge_bps)} bps of expected edge left over and ${num(k.min_conviction)}/100 conviction.`,
    `No entries on quotes older than ${num(k.max_quote_age_seconds)} s or spreads wider than ${num(k.max_spread_bps)} bps, and no re-buying a coin within ${minutes(k.reentry_cooldown_minutes)} of selling it. The AI can't close a position younger than ${minutes(k.min_hold_minutes)} unless its stop or invalidation hits, and stops only ever move up.`,
    `A day down ${num(p.max_daily_loss_pct)}% blocks new entries until the next UTC day. A ${num(p.max_drawdown_pct)}% drawdown from peak equity engages the kill switch${p.drawdown_action === "halt_and_liquidate" ? " and sells everything" : ""}.`,
    `AI spend is capped at ${usd(s.ai.daily_budget_usd, { whole: Number.isInteger(s.ai.daily_budget_usd) })} a day. Stale data, failed research, an invalid response or a spent budget all mean no trade.`,
    "The AI can't change any of this: settings change only through audited owner commands. Every research memo, decision (including no-trades and rejected orders), risk check, order and fill is stored and shown on this site.",
  ]
}

export default async function AboutPage() {
  const parsed = settingsSchema.safeParse((await getSettings().catch(() => null))?.settings)
  const s = parsed.success ? parsed.data : DEFAULT_SETTINGS
  return (
    <div className="space-y-8">
      <PageHeader
        title="How it works"
        description="An experiment in whether an AI that reads the web and X in real time can trade crypto profitably, 24/7, after fees, with a risk engine that has the final word."
      />
      <section className="grid gap-3 sm:grid-cols-2">
        {cycle(s).map((step, i) => (
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
        <h2 className="mb-3 text-base font-semibold">Each cycle makes two Grok calls</h2>
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            <span className="text-foreground font-medium">Research</span> ({s.ai.models.research}): live web search{s.ai.x_search ? " and X search" : ""} produce a
            sourced memo, with every claim labeled fact, sourced claim, estimate or speculation. Grok does not decide anything here.
          </li>
          <li>
            <span className="text-foreground font-medium">Decision</span> ({s.ai.models.decision}): the memo, the market data and the risk limits become one
            structured decision per candidate and open position: action, conviction, the odds of hitting the target before the stop, stop and target, bull and
            bear evidence, risks and what would prove it wrong. It is validated, repaired or retried if invalid, and only URLs research actually retrieved count
            as sources.
          </li>
        </ol>
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
            The quant screens are{" "}
            <Link href="/strategies" className="text-foreground underline underline-offset-2">
              backtested
            </Link>{" "}
            bar by bar with fees and slippage, in-sample and out-of-sample, against buy-and-hold BTC. The AI isn&apos;t: a model asked about past prices has
            probably seen what happened next.
          </li>
          <li>
            So the AI is judged going forward:{" "}
            <Link href="/analytics" className="text-foreground underline underline-offset-2">
              Analytics
            </Link>{" "}
            compares what it bought with what it skipped and with the screens alone, and checks how well calibrated its odds are.
          </li>
          <li>Nothing learns automatically. Strategies and prompts change only by hand, and every decision records the model and prompt version it used.</li>
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
