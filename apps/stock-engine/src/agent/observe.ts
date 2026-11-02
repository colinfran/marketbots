import { checkEntry } from "@mb/agent/envelope"
import type { Wake } from "@mb/agent/queue"
import { briefNews } from "@mb/agent/wire-tools"
import { BOOK_SUBJECT, MARKET_SUBJECT, type Observation } from "@mb/core/agent"
import { errorMessage } from "@mb/engine-kit/log"
import { formatTime, marketDay } from "@mb/stock-core/time"
import { upcomingMacro } from "@mb/wire/calendar"
import { sessionWindow, sidePrices, type StockAgentDeps } from "./book"
import { storedBook, type StoredBook } from "./live"
import { StockScreen } from "./screen"
import { stockWireDeps } from "./tools"
import { bookText, envelopeHistory, heldPositions, heldSymbols } from "./view"

/**
 * What wakes the stock agent besides news (docs/plans/LOCAL-AI.md §8.1, §8.7), checked by code as
 * the data arrives:
 *
 *   session      premarket (P2: plan, watches and notes only), the open after its buffer (P2), the
 *                closing window while the book holds anything (P1), after the close (P3: review)
 *   bar close    each closed minute of the price board (the scan universe and what the engine
 *                tracks) goes through the setup screen (./screen); while buys are allowed and the
 *                envelope would take one, the minute's best setups on stocks not in the book wake
 *                the agent together, as one P1
 *   every 5 s    in session: a held stock moving `schedule.trigger_move_pct` since your last review
 *                (down: P0, up: P2), again at every further step; stops and targets rest at the
 *                broker, and a stop or target it fills is a P2 (onPositionClosed)
 *   each minute  a scheduled release 15 minutes out is a P2 about the market
 *   quiet time   in session, a P2 review once nothing has woken the agent for `agent.sweep_minutes`
 *
 * News comes from the wire policy's observe hook (engine.ts), around the clock: outside the session
 * the agent can only set watches and notes.
 *
 * The observers read the book's plans and options from the database at most every `BOOK_MS`, as the
 * account itself refreshes: the database is a small shared one, and a read every second was most of
 * the stock engine's traffic to it in the closing window.
 */

const EXITS_MS = 5_000
const BOOK_MS = 15_000
const CALENDAR_LEAD_MS = 15 * 60_000
const OVERNIGHT_MINUTES = 3
const MIN = 60_000
/** The most setups one wake-up lists. */
const MAX_SETUPS = 5

export class StockObserver {
  private last = { exits: 0, calendar: 0, sweep: Date.now() }
  private readonly done = new Set<string>()
  private readonly moves = new Map<string, string>()
  private readonly screen = new StockScreen()
  private stored: { at: number; book: StoredBook } | null = null

  constructor(
    private readonly d: StockAgentDeps,
    private readonly observe: (o: Observation) => void,
    /** When the agent's last episode finished (0: none yet), for the quiet-time review. */
    private readonly lastEpisodeAt: () => number = () => 0,
  ) {}

  /** One closed minute of the price board: the screen sees every bar; its setups wake the agent only while a buy could happen. */
  async onBars(bars: readonly { symbol: string; t: number; close: number; volume: number }[], now = new Date()) {
    const s = this.d.session()
    const setups = this.screen.onBars(bars, { open: s?.is_trading_day ? (s.open ?? null) : null, day: marketDay(now), minPrice: this.d.ctx.settings.current.risk.min_price })
    if (!setups.length || !sessionWindow(this.d, now).entries) return
    if (!checkEntry("", await envelopeHistory(this.d, now.getTime()), this.d.ctx.settings.current.agent.envelope, now.getTime()).approved) return
    const held = await heldSymbols(this.d, await this.storedBook(now))
    for (const x of setups.filter((x) => !held.has(x.symbol)).slice(0, MAX_SETUPS)) {
      this.observe({ id: `setup:${x.symbol}:${x.kind}:${x.t}`, subject: MARKET_SUBJECT, kind: "setup", priority: 1, salience: x.score, summary: x.summary, refs: { symbol: x.symbol }, at: now })
    }
  }

  /** onBars for the engine's callback: never throws. */
  bars(bars: readonly { symbol: string; t: number; close: number; volume: number }[]) {
    void this.onBars(bars).catch((e) => this.d.ctx.log.warn("agent setups failed", { error: errorMessage(e) }))
  }

  /** The book's plans and options, read again once they are `BOOK_MS` old. */
  private async storedBook(now: Date) {
    const t = now.getTime()
    if (!this.stored || t - this.stored.at >= BOOK_MS) this.stored = { at: t, book: await storedBook(this.d) }
    return this.stored.book
  }

  /** Each key once: a session phase per day, a release, the overnight rule per day. */
  private once(key: string) {
    if (this.done.has(key)) return false
    this.done.add(key)
    if (this.done.size > 500) this.done.delete(this.done.values().next().value!)
    return true
  }

  async tick(now: Date) {
    const t = now.getTime()
    const window = sessionWindow(this.d, now)
    await this.phases(now)
    // Stops and targets rest at the broker, and the overnight rule is the engine's maintenance; the agent watches the moves.
    if (window.open && t - this.last.exits >= EXITS_MS) {
      this.last.exits = t
      await this.priceMoves(now)
    }
    if (t - this.last.calendar >= MIN) {
      this.last.calendar = t
      this.calendarEvents(now)
    }
    // The open's own wake-up counts: the first review comes a full quiet spell after it.
    const quietSince = Math.max(this.last.sweep, this.lastEpisodeAt())
    if (window.entries && t - quietSince >= this.d.ctx.settings.current.agent.sweep_minutes * MIN) {
      this.last.sweep = t
      this.observe({
        id: `sweep:${t}`,
        subject: MARKET_SUBJECT,
        kind: "sweep",
        priority: 2,
        salience: 30,
        summary: `Quiet-time review: nothing has woken you for ${Math.round((t - quietSince) / MIN)} min. Check your book, the market, and anything nothing else woke you for.`,
        refs: {},
        at: now,
      })
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
    if (t >= close - sch.close_window_minutes * MIN && t < close && !this.done.has(`${s.day}:close`) && (await heldSymbols(this.d, await this.storedBook(now))).size) {
      at({ subject: BOOK_SUBJECT, kind: "session", priority: 1, salience: 60, summary: `Closing window: the session ends at ${formatTime(s.close)}. Decide what you carry overnight; intraday positions are closed by code ${OVERNIGHT_MINUTES} minutes before the bell.` }, "close")
    }
    if (t >= close + sch.postmarket_delay_minutes * MIN && t < close + 3 * 60 * MIN) {
      at({ subject: MARKET_SUBJECT, kind: "session", priority: 3, salience: 40, summary: "After the close: review today's decisions and your book, and leave notes and watches for tomorrow." }, "postmarket")
    }
  }

  private async priceMoves(now: Date) {
    const step = this.d.ctx.settings.current.schedule.trigger_move_pct
    for (const p of await heldPositions(this.d, await this.storedBook(now))) {
      const m = this.d.price(p.symbol)
      const ref = p.reviewPrice ?? p.entry
      if (!m) continue
      const moved = Math.abs(m / ref - 1) * 100
      if (moved < step) continue
      const key = `${p.reviewedAt?.getTime() ?? 0}:${Math.floor(moved / step)}`
      if (this.moves.get(p.id) === key) continue
      this.moves.set(p.id, key)
      const down = m < ref
      this.observe({
        id: `move:${p.id}:${key}`,
        subject: p.symbol,
        kind: "price",
        priority: down ? 0 : 2,
        salience: Math.min(100, Math.round(50 + (10 * moved) / step)),
        summary: `${p.symbol}, which you hold, moved ${((m / ref - 1) * 100).toFixed(2)}% since your last review at ${ref.toFixed(2)}; stop ${p.stop ?? "none"}.`,
        refs: { position_id: p.id },
        at: now,
      })
    }
  }

  /** Level auto: a stock position the broker closed at its stop or target is worth a look at what's left. */
  onPositionClosed(e: { symbol: string; asset_class: string; realized_pnl_usd: number | null; return_pct: number | null; reason: string }, now = new Date()) {
    if (e.reason !== "stop-loss" && e.reason !== "take-profit") return
    this.observe({
      id: `fill:${e.symbol}:${now.getTime()}`,
      subject: e.symbol,
      kind: "fill",
      priority: 2,
      salience: 60,
      summary: `Your ${e.symbol} position hit its ${e.reason === "stop-loss" ? "stop" : "target"}${e.realized_pnl_usd !== null ? `: ${e.realized_pnl_usd >= 0 ? "+" : "-"}$${Math.abs(e.realized_pnl_usd).toFixed(2)}` : ""}${e.return_pct !== null ? ` (${e.return_pct >= 0 ? "+" : ""}${e.return_pct}%)` : ""}.`,
      refs: {},
      at: now,
    })
  }

  private calendarEvents(now: Date) {
    for (const e of upcomingMacro(now, 1)) {
      const key = `${e.kind}:${e.at.toISOString()}`
      if (e.at.getTime() - now.getTime() > CALENDAR_LEAD_MS || !this.once(`calendar:${key}`)) continue
      this.observe({ id: `calendar:${key}`, subject: MARKET_SUBJECT, kind: "calendar", priority: 2, salience: 55, summary: `${e.title} at ${formatTime(e.at)}, in ${Math.round((e.at.getTime() - now.getTime()) / MIN)} min.`, refs: {}, at: now })
    }
  }
}

/** The bot's part of the brief: the book and its limits, the market, each subject with its latest news (whose URLs count as seen). */
export const stockBrief = async (d: StockAgentDeps, wake: Wake) => {
  const benchmarks = d.ctx.settings.current.universe.benchmarks.slice(0, 6).map((s) => {
    const live = d.ctx.prices.get(s)
    const p = d.price(s)
    return p === null ? `${s} n/a` : `${s} ${p}${live?.change_pct !== null && live?.change_pct !== undefined ? ` (${live.change_pct >= 0 ? "+" : ""}${live.change_pct}%)` : ""}`
  })
  const sections = [await bookText(d), `MARKET\n- ${benchmarks.join(", ")}`]
  // The stock that woke the agent, or each stock of a market-wide wake-up's setups, with what our
  // feeds say about it: a move's catalyst, or that nothing explains it, is in front of the agent either way.
  const urls: string[] = []
  const wire = stockWireDeps(d)
  for (const symbol of new Set([wake.subject, ...wake.observations.map((o) => o.refs.symbol).filter((s): s is string => !!s)])) {
    const p = sidePrices(d, symbol)
    if (!p) continue
    const live = d.ctx.prices.get(symbol)
    const news = await briefNews(wire, symbol)
    urls.push(...news.urls)
    sections.push(
      `SUBJECT ${symbol}\n- ${p.last}${live?.bid && live.ask ? ` (bid ${live.bid}, ask ${live.ask})` : ""}${live?.change_pct !== null && live?.change_pct !== undefined ? `, ${live.change_pct >= 0 ? "+" : ""}${live.change_pct}% today` : ""}; technicals: use the tools\n${news.text}`,
    )
  }
  return { text: sections.join("\n\n"), urls }
}
