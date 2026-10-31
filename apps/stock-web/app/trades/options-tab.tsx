import Link from "next/link"
import { Delta, SectionTitle, Stat } from "@/components/bits"
import { OptionsTable } from "@/components/tables"
import { usd } from "@/lib/format"
import { getLiveAccount, getOptionsPositions, getSettings } from "@/lib/queries"

/** The Trades page's Options tab: the options book's numbers, every closed position and how they work. Open positions are on Holdings. */
export async function OptionsTab() {
  const [{ open, closed }, live, settings] = await Promise.all([getOptionsPositions(), getLiveAccount(), getSettings()])
  const o = settings.options
  const realized = closed.reduce((sum, p) => sum + (p.realized_pnl_usd ?? 0), 0)
  const scored = closed.filter((p) => p.realized_pnl_usd !== null)
  const wins = scored.filter((p) => (p.realized_pnl_usd ?? 0) > 0).length
  const unrealized = open.reduce((sum, p) => sum + (p.mark?.pnl_usd ?? 0), 0)
  const premium = open.reduce((sum, p) => sum + (p.cost_usd ?? 0), 0)

  return (
    <div className="space-y-8">
      <p className="text-muted-foreground max-w-3xl text-sm">
        Defined-risk positions only: long calls, long puts{o.allow_spreads ? " and call/put debit spreads" : ""}. The most any position can lose is what was paid. The engine
        checks every position against its exits every {o.monitor_seconds} seconds and closes it {o.close_at_dte} day{o.close_at_dte === 1 ? "" : "s"} before expiration, so
        nothing is exercised or assigned.
      </p>
      {!o.enabled && <p className="text-muted-foreground text-sm">Options trading is currently turned off in settings.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open positions" value={`${open.length}/${o.max_open_positions}`} sub={<span className="text-muted-foreground">{usd(premium)} paid</span>} />
        <Stat
          label="Premium at risk"
          value={live?.equity ? `${((premium / live.equity) * 100).toFixed(1)}%` : "—"}
          sub={<span className="text-muted-foreground">cap {o.max_total_premium_pct}% of equity · {o.max_premium_per_trade_pct}% per trade</span>}
        />
        <Stat label="Unrealized" value={<Delta value={unrealized} className="text-2xl" />} />
        <Stat
          label="Realized"
          value={<Delta value={realized} className="text-2xl" />}
          sub={<span className="text-muted-foreground">{scored.length ? `${wins}/${scored.length} profitable` : "No closed positions yet"}</span>}
        />
      </div>
      <section>
        <SectionTitle
          action={
            <Link href="/holdings" className="text-muted-foreground text-sm hover:underline">
              Open positions
            </Link>
          }
        >
          Closed
        </SectionTitle>
        <OptionsTable positions={closed} closed />
      </section>
      <section className="text-muted-foreground max-w-3xl space-y-2 text-sm">
        <h2 className="text-foreground text-base font-semibold">How options trades work</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            When the agent asks, code loads a short menu of liquid contracts per stock: {o.min_dte}–{o.max_dte} days to expiration, open interest of at least {o.min_open_interest}, bid-ask
            spread under {o.max_spread_pct}%. The agent can only choose from that menu.
          </li>
          <li>
            The contract bought must have a delta between {o.min_delta} and {o.max_delta}. Spreads buy one strike and sell a further one in the same expiration, as one order.
          </li>
          <li>Entries are limit orders between the midpoint and the ask, canceled if not filled within {o.fill_timeout_seconds} seconds.</li>
          <li>
            Exits: the position&apos;s value falling {o.default_stop_loss_pct}% or rising {o.default_take_profit_pct}% (unless the AI set its own), the stock crossing the AI&apos;s
            invalidation or target price, or {o.close_at_dte} day{o.close_at_dte === 1 ? "" : "s"} left to expiration.
          </li>
        </ul>
      </section>
    </div>
  )
}
