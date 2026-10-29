import type { Wake } from "@mb/agent/queue"
import { BOOK_SUBJECT, MARKET_SUBJECT, type Observation } from "@mb/core/agent"
import { formatTime } from "@mb/stock-core/time"
import { upcomingMacro } from "@mb/wire/calendar"
import { bookText, sessionWindow, sidePrices, type StockAgentDeps } from "./book"

/**
 * What wakes the stock agent besides news (docs/plans/LOCAL-AI.md §8.1, §8.7), checked by code:
 *
 *   session      premarket (P2: plan, watches and notes only), the open after its buffer (P2), the
 *                closing window while the book holds anything (P1), after the close (P3: review)
 *   every 5 s    in session: the shadow book's stops and targets against the bid; a fill is a P2
 *   every 15 s   in session: marks, and a held stock moving `schedule.trigger_move_pct` since your
 *                last review (down: P0, up: P2), again at every further step
 *   bell - 3 min intraday positions are closed by code (the overnight rule), as the cycles do
 *   each minute  a scheduled release 15 minutes out is a P2 about the market
 *   sweep        in session, a P2 review every `agent.sweep_minutes`
 *
 * News comes from the wire policy's observe hook (engine.ts), around the clock: outside the session
 * the agent can only set watches and notes.
 */

const EXITS_MS = 5_000
const MARK_MS = 15_000
const CALENDAR_LEAD_MS = 15 * 60_000
const OVERNIGHT_MINUTES = 3
const MIN = 60_000

export class StockObserver {
  private last = { exits: 0, mark: 0, calendar: 0, sweep: 0 }
  private readonly done = new Set<string>()
  private readonly moves = new Map<string, string>()

  constructor(
    private readonly d: StockAgentDeps,
    private readonly observe: (o: Observation) => void,
  ) {}

  /** Each key once: a session phase per day, a release, the overnight rule per day. */
  private once(key: string) {
    if (this.done.has(key)) return false
    this.done.add(key)
    if (this.done.size > 500) this.done.delete(this.done.values().next().value!)
    return true
  }

  async tick(now: Date) {
    const t = now.getTime()
    const s = this.d.session()
    const window = sessionWindow(this.d, now)
    await this.phases(now)
    if (window.open && t - this.last.exits >= EXITS_MS) {
      this.last.exits = t
      await this.exits(now)
    }
    if (window.open && t - this.last.mark >= MARK_MS) {
      this.last.mark = t
      await this.d.shadow.mark(this.d.price)
      await this.priceMoves(now)
    }
    if (window.open && s?.close && s.close.getTime() - t <= OVERNIGHT_MINUTES * MIN && this.once(`overnight:${s.day}`)) await this.overnight()
    if (t - this.last.calendar >= MIN) {
      this.last.calendar = t
      this.calendarEvents(now)
    }
    if (window.entries && t - this.last.sweep >= this.d.ctx.settings.current.agent.sweep_minutes * MIN) {
      // The first sweep comes a full interval after the open's own wake-up.
      if (this.last.sweep) this.observe({ id: `sweep:${t}`, subject: MARKET_SUBJECT, kind: "sweep", priority: 2, salience: 30, summary: "Periodic review: your book, the market, and anything nothing else woke you for.", refs: {}, at: now })
      this.last.sweep = t
    }
  }

  private async phases(now: Date) {
    const s = this.d.session()
    if (!s?.is_trading_day || !s.open || !s.close) return
    const sch = this.d.ctx.settings.current.schedule
    const t = now.getTime()
    const open = s.open.getTime()
    const close = s.close.getTime()
    const at = (o: Omit<Observation, "id" | "refs" | "at">, key: string) => {
      if (this.once(`${s.day}:${key}`)) this.observe({ ...o, id: `session:${s.day}:${key}`, refs: {}, at: now })
    }
    if (t >= open - sch.premarket_lead_minutes * MIN && t < open) {
      at({ subject: MARKET_SUBJECT, kind: "session", priority: 2, salience: 50, summary: `Premarket: the session opens at ${formatTime(s.open)}; buys are allowed from ${formatTime(new Date(open + sch.open_buffer_minutes * MIN))}. Plan the day: set watches and notes for the open.` }, "premarket")
    }
    if (t >= open + sch.open_buffer_minutes * MIN && t < close - sch.close_window_minutes * MIN) {
      at({ subject: MARKET_SUBJECT, kind: "session", priority: 2, salience: 50, summary: `The session is open and past its opening buffer: buys are allowed until the close at ${formatTime(s.close)}.` }, "open")
    }
    if (t >= close - sch.close_window_minutes * MIN && t < close && (await this.d.shadow.open()).length) {
      at({ subject: BOOK_SUBJECT, kind: "session", priority: 1, salience: 60, summary: `Closing window: the session ends at ${formatTime(s.close)}. Decide what you carry overnight; intraday positions are closed by code ${OVERNIGHT_MINUTES} minutes before the bell.` }, "close")
    }
    if (t >= close + sch.postmarket_delay_minutes * MIN && t < close + 3 * 60 * MIN) {
      at({ subject: MARKET_SUBJECT, kind: "session", priority: 3, salience: 40, summary: "After the close: review today's decisions and your book, and leave notes and watches for tomorrow." }, "postmarket")
    }
  }

  private async exits(now: Date) {
    const fills = await this.d.shadow.checkExits((s) => sidePrices(this.d, s)?.bid ?? null)
    for (const f of fills) {
      this.observe({
        id: `fill:${f._id}`,
        subject: f.symbol,
        kind: "fill",
        priority: 2,
        salience: 60,
        summary: `Your shadow ${f.symbol} position hit its ${f.reason === "stop_loss" ? "stop" : "target"}: sold ${f.qty} at ${f.price.toFixed(2)}, ${(f.realized_pnl_usd ?? 0) >= 0 ? "+" : "-"}$${Math.abs(f.realized_pnl_usd ?? 0).toFixed(2)}.`,
        refs: { position_id: f.position_id },
        at: now,
      })
    }
  }

  private async priceMoves(now: Date) {
    const step = this.d.ctx.settings.current.schedule.trigger_move_pct
    for (const p of await this.d.shadow.open()) {
      const m = this.d.price(p.symbol)
      const ref = p.last_review_price ?? p.entry_price
      if (!m) continue
      const moved = Math.abs(m / ref - 1) * 100
      if (moved < step) continue
      const key = `${p.last_reviewed_at?.getTime() ?? 0}:${Math.floor(moved / step)}`
      if (this.moves.get(p._id) === key) continue
      this.moves.set(p._id, key)
      const down = m < ref
      this.observe({
        id: `move:${p._id}:${key}`,
        subject: p.symbol,
        kind: "price",
        priority: down ? 0 : 2,
        salience: Math.min(100, Math.round(50 + (10 * moved) / step)),
        summary: `${p.symbol}, which you hold, moved ${((m / ref - 1) * 100).toFixed(2)}% since your last review at ${ref.toFixed(2)}; stop ${p.stop_price ?? "none"}.`,
        refs: { position_id: p._id },
        at: now,
      })
    }
  }

  /** Never leave an intraday position open overnight (the cycles' overnight rule). */
  private async overnight() {
    for (const p of await this.d.shadow.open()) {
      if (p.horizon !== "intraday") continue
      const bid = sidePrices(this.d, p.symbol)?.bid
      if (bid) await this.d.shadow.sell(p, { reference: bid, reason: "overnight", episodeId: null })
    }
  }

  private calendarEvents(now: Date) {
    for (const e of upcomingMacro(now, 1)) {
      const key = `${e.kind}:${e.at.toISOString()}`
      if (e.at.getTime() - now.getTime() > CALENDAR_LEAD_MS || !this.once(`calendar:${key}`)) continue
      this.observe({ id: `calendar:${key}`, subject: MARKET_SUBJECT, kind: "calendar", priority: 2, salience: 55, summary: `${e.title} at ${formatTime(e.at)}, in ${Math.round((e.at.getTime() - now.getTime()) / MIN)} min.`, refs: {}, at: now })
    }
  }
}

/** The bot's part of the brief: the book and its limits, the market, the subject. */
export const stockBrief = async (d: StockAgentDeps, wake: Wake) => {
  const benchmarks = d.ctx.settings.current.universe.benchmarks.slice(0, 6).map((s) => {
    const live = d.ctx.prices.get(s)
    const p = d.price(s)
    return p === null ? `${s} n/a` : `${s} ${p}${live?.change_pct !== null && live?.change_pct !== undefined ? ` (${live.change_pct >= 0 ? "+" : ""}${live.change_pct}%)` : ""}`
  })
  const sections = [await bookText(d), `MARKET\n- ${benchmarks.join(", ")}`]
  const p = sidePrices(d, wake.subject)
  if (p) {
    const live = d.ctx.prices.get(wake.subject)
    sections.push(`SUBJECT ${wake.subject}\n- ${p.last}${live?.bid && live.ask ? ` (bid ${live.bid}, ask ${live.ask})` : ""}${live?.change_pct !== null && live?.change_pct !== undefined ? `, ${live.change_pct >= 0 ? "+" : ""}${live.change_pct}% today` : ""}; technicals and news: use the tools`)
  }
  return { text: sections.join("\n\n"), urls: [] }
}
