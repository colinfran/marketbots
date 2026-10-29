import type { EngineEvent } from "@mb/crypto-core/events"
import { normalizeCryptoReport } from "@mb/crypto-core/report"
import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import type { EventFocus, WireItemDoc } from "@mb/crypto-core/wire"
import type { ResearchProgress, StructuredProgress } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import type { AiRunner } from "../src/ai/runner"
import type { Alerts } from "../src/alerts"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { CandleCache } from "../src/market/candles"
import type { MarketHub } from "../src/market/hub"
import type { EngineContext } from "../src/orchestrator/context"
import { eventCandidates, researchPlan, runCryptoCycle } from "../src/orchestrator/crypto-cycle"
import { Ledger } from "../src/portfolio/ledger"
import type { EngineStateStore, SettingsStore } from "../src/state/stores"
import { assembleDossier } from "../src/wire/dossier"
import { cryptoRules, WirePolicy } from "../src/wire/policy"
import { useTestDb } from "./helpers/db"
import { candles, fakeHub, FakeWallet, makeBus } from "./helpers/fakes"

const db = useTestDb()
const NOW = new Date("2026-10-27T15:00:00Z")
const HOUR = 3_600_000

const item = (overrides: Partial<WireItemDoc> = {}): WireItemDoc => ({
  _id: `i-${Math.random().toString(36).slice(2, 10)}`,
  cluster_id: "",
  source: "rss:coindesk",
  tier: 2,
  kind: "news",
  category: "general",
  title: "Something happened",
  summary: null,
  url: "https://coindesk.com/x",
  domain: "coindesk.com",
  symbols: ["BTC/USD"],
  published_at: new Date(NOW.getTime() - 60_000),
  first_seen_at: new Date(NOW.getTime() - 30_000),
  polarity: 0,
  severity: 60,
  severity_parts: {},
  confirmations: [],
  price_at_seen: {},
  meta: {},
  notable: false,
  notable_reasons: [],
  expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
  ...overrides,
})
const withRoot = (i: WireItemDoc) => ({ ...i, cluster_id: i._id })

const setupPolicy = async ({ held = ["BTC/USD"], settings = DEFAULT_SETTINGS, running = true, observe }: { held?: string[]; settings?: Settings; running?: boolean; observe?: (item: WireItemDoc, c: { rule: string }) => void } = {}) => {
  const bus = await makeBus(db.col)
  const request = vi.fn<(f: EventFocus) => "fired" | "queued">(() => "fired")
  const markNotable = vi.fn(async () => undefined)
  const emergency = vi.fn(async () => "stop raised")
  const alert = vi.fn(async () => undefined)
  const policy = new WirePolicy({
    col: db.col,
    bus,
    log: silentLogger,
    settings: () => settings,
    rules: cryptoRules,
    engine: () => ({ running, killSwitch: false }),
    held: () => held,
    universe: () => ["BTC/USD", "ETH/USD", "SOL/USD"],
    request,
    markNotable,
    emergency,
    alert,
    observe,
    now: () => NOW,
  })
  return { policy, request, markNotable, emergency, alert }
}
const triggers = () => db.col.wireTriggers.find({}).sort({ at: 1 }).toArray()
const unexplainedOn: Settings = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, unexplained_move_entries: true } }

describe("wire policy", () => {
  it("lets the agent observe what passes the item's own gates, whatever the caps say", async () => {
    const observe = vi.fn()
    const capped: Settings = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, max_event_cycles_per_hour: 0 } }
    const { policy, request } = await setupPolicy({ settings: capped, observe })
    const fresh = withRoot(item({ polarity: -1, severity: 62, category: "regulatory_action", title: "SEC probes bitcoin custodian" }))
    await policy.onItem({ item: fresh, backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(fresh, expect.objectContaining({ rule: "held_negative", action: "review", symbols: ["BTC/USD"] }))
    observe.mockClear()
    await policy.onItem({ item: withRoot(item({ polarity: -1, severity: 62, category: "regulatory_action", first_seen_at: new Date(NOW.getTime() - 3 * HOUR) })), backfill: false, confirmation: false })
    await policy.onItem({ item: withRoot(item({ polarity: -1, severity: 62, category: "regulatory_action" })), backfill: true, confirmation: false })
    expect(observe).not.toHaveBeenCalled()
  })

  it("reviews a held position on negative news and marks the item notable", async () => {
    const { policy, request, markNotable } = await setupPolicy()
    const i = withRoot(item({ polarity: -1, severity: 62, category: "regulatory_action", title: "SEC probes bitcoin custodian" }))
    await policy.onItem({ item: i, backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTC/USD", rule: "held_negative", action: "review" }))
    expect(await triggers()).toEqual([expect.objectContaining({ rule: "held_negative", status: "fired", item_ids: [i._id] })])
    expect(markNotable).toHaveBeenCalledWith([i._id], "triggered")
  })

  it("holds an entry back until it is confirmed, then fires on the confirmation", async () => {
    const { policy, request } = await setupPolicy({ held: [] })
    const i = withRoot(item({ symbols: ["SOL/USD"], polarity: 1, severity: 74, category: "etf_decision", title: "SEC approves spot Solana ETF" }))
    await policy.onItem({ item: i, backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect((await triggers())[0]).toMatchObject({ rule: "entry_event", status: "suppressed", reason: expect.stringContaining("unconfirmed") })
    await policy.onItem({ item: { ...i, confirmations: [{ domain: "theblock.co", url: null, at: NOW }] }, backfill: false, confirmation: true })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "SOL/USD", action: "evaluate", polarity: 1 }))
  })

  it("never fires for backfill, stale or old items, and never longs into a hack", async () => {
    const { policy, request } = await setupPolicy({ held: [] })
    const fresh = { polarity: -1 as const, severity: 70, symbols: ["BTC/USD"] }
    await policy.onItem({ item: withRoot(item(fresh)), backfill: true, confirmation: false })
    await policy.onItem({ item: withRoot(item({ ...fresh, first_seen_at: new Date(NOW.getTime() - 20 * 60_000) })), backfill: false, confirmation: false })
    await policy.onItem({ item: withRoot(item({ symbols: ["ETH/USD"], category: "exploit", polarity: 1, severity: 90, tier: 1 })), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    // Backfill isn't even worth an audit row; the hack produced no candidate at all.
    expect(await triggers()).toEqual([])
    const { policy: p2, request: r2 } = await setupPolicy()
    await p2.onItem({ item: withRoot(item({ ...fresh, first_seen_at: new Date(NOW.getTime() - 20 * 60_000) })), backfill: false, confirmation: false })
    expect(r2).not.toHaveBeenCalled()
    expect((await triggers())[0]).toMatchObject({ status: "suppressed", reason: expect.stringContaining("stale") })
  })

  it("applies cooldowns, caps, pause and shadow mode", async () => {
    const neg = () => withRoot(item({ polarity: -1, severity: 62 }))
    const a = await setupPolicy()
    await a.policy.onItem({ item: neg(), backfill: false, confirmation: false })
    await a.policy.onItem({ item: neg(), backfill: false, confirmation: false })
    expect(a.request).toHaveBeenCalledTimes(1)
    expect((await triggers()).find((t) => t.status === "suppressed")).toMatchObject({ reason: expect.stringContaining("cooldown") })

    await db.col.wireTriggers.deleteMany({})
    const capped = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, max_event_cycles_per_hour: 0 } }
    const b = await setupPolicy({ settings: capped })
    await b.policy.onItem({ item: neg(), backfill: false, confirmation: false })
    expect((await triggers())[0]).toMatchObject({ status: "suppressed", reason: expect.stringContaining("hourly cap") })

    await db.col.wireTriggers.deleteMany({})
    const d = await setupPolicy({ running: false })
    await d.policy.onItem({ item: neg(), backfill: false, confirmation: false })
    expect((await triggers())[0]).toMatchObject({ status: "suppressed", reason: "engine is paused" })

    await db.col.wireTriggers.deleteMany({})
    const e = await setupPolicy({ settings: { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, mode: "shadow" } } })
    await e.policy.onItem({ item: neg(), backfill: false, confirmation: false })
    expect(e.request).not.toHaveBeenCalled()
    expect((await triggers())[0]).toMatchObject({ status: "shadow" })
  })

  it("runs the owner's emergency action on critical confirmed bad news, and replays without side effects", async () => {
    const tighten = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, emergency_action: "tighten_stop" as const } }
    const { policy, emergency, request } = await setupPolicy({ settings: tighten })
    const crit = withRoot(item({ polarity: -1, severity: 90, tier: 1, category: "regulatory_action" }))
    await policy.onItem({ item: crit, backfill: false, confirmation: false })
    expect(emergency).toHaveBeenCalledWith("BTC/USD", expect.anything())
    expect((await triggers()).map((t) => t.action).sort()).toEqual(["emergency", "review"])
    request.mockClear()
    expect(await policy.replay(withRoot(item({ polarity: -1, severity: 62, _id: "replay-1" })))).toMatch(/held_negative → review on BTC\/USD/)
    expect(request).not.toHaveBeenCalled()
  })

  it("flags unexplained moves only when no news explains them", async () => {
    const { policy, request } = await setupPolicy({ held: [], settings: unexplainedOn })
    const move = withRoot(item({ kind: "anomaly", category: "price_shock", tier: 1, symbols: ["ETH/USD"], polarity: 1, severity: 63, meta: { anomaly: "price" } }))
    await db.col.wireItems.insertOne(withRoot(item({ symbols: ["ETH/USD"], first_seen_at: new Date(NOW.getTime() - 10 * 60_000) })))
    await policy.onItem({ item: move, backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    await db.col.wireItems.deleteMany({})
    await policy.onItem({ item: { ...move, _id: "move-2", cluster_id: "move-2" }, backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ rule: "unexplained_move", action: "gap_fill", symbol: "ETH/USD" }))
  })

  it("with unexplained_move_entries off (the default), an unexplained move only reviews what we hold", async () => {
    const move = withRoot(item({ kind: "anomaly", category: "price_shock", tier: 1, symbols: ["ETH/USD"], polarity: 1, severity: 63, meta: { anomaly: "price" } }))
    const { policy: flat } = await setupPolicy({ held: [] })
    expect(await flat.candidates(move)).toEqual([])
    const { policy: holding } = await setupPolicy({ held: ["ETH/USD"] })
    expect(await holding.candidates(move)).toEqual([{ rule: "unexplained_move", action: "gap_fill", symbols: ["ETH/USD"], entry: false }])
  })
})

describe("wave-2 policy rules", () => {
  it("reviews a held asset on a chain TVL drop, and never buys one", async () => {
    const drop = (symbols: string[]) => withRoot(item({ source: "defillama", tier: 1, category: "tvl_drop", symbols, polarity: -1, severity: 90, meta: { metric: "defillama:tvl:Solana" } }))
    const { policy, request } = await setupPolicy({ held: ["SOL/USD"] })
    expect(await policy.candidates(drop(["SOL/USD"]))).toEqual([{ rule: "exploit_signal", action: "review", symbols: ["SOL/USD"], entry: false }])
    await policy.onItem({ item: drop(["SOL/USD"]), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "SOL/USD", rule: "exploit_signal", action: "review" }))
    const { policy: notHeld } = await setupPolicy({ held: [] })
    expect(await notHeld.candidates(drop(["ETH/USD"]))).toEqual([])
    expect(await notHeld.candidates(drop([]))).toEqual([])
  })

  it("annotates odds swings unless one is critical while something is held", async () => {
    const swing = (severity: number) => withRoot(item({ source: "odds:polymarket", tier: 2, kind: "sentiment", category: "odds_swing", symbols: [], severity, meta: { metric: "polymarket:1" } }))
    const { policy, request } = await setupPolicy()
    expect(await policy.candidates(swing(70))).toEqual([])
    await policy.onItem({ item: swing(90), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: null, rule: "odds_swing", action: "market_review" }))
    const { policy: flat } = await setupPolicy({ held: [] })
    expect(await flat.candidates(swing(95))).toEqual([])
  })

  it("only annotates funding, the Coinbase premium, attention, liquidations and network stress", async () => {
    const { policy, request } = await setupPolicy({ held: ["BTC/USD"] })
    for (const category of ["funding_extreme", "coinbase_premium", "sentiment_spike", "liquidation_cascade", "volume_shock"] as const) {
      const reading = withRoot(item({ source: "coinalyze", tier: 1, kind: "derivatives", category, polarity: -1, severity: 95, symbols: ["BTC/USD"], meta: { metric: `x:${category}` } }))
      expect(await policy.candidates(reading)).toEqual([])
      await policy.onItem({ item: reading, backfill: false, confirmation: false })
    }
    expect(request).not.toHaveBeenCalled()
    expect(await triggers()).toEqual([])
  })

  it("treats a Coinbase listing of a universe asset as an entry event (venue data is tier 1)", async () => {
    const { policy, request } = await setupPolicy({ held: [] })
    const listing = withRoot(item({ source: "coinbase_products", tier: 1, kind: "venue", category: "listing_major", symbols: ["SOL/USD"], polarity: 1, severity: 78, title: "Coinbase lists SOL/USD" }))
    await policy.onItem({ item: listing, backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "SOL/USD", rule: "listing_major", action: "evaluate" }))
  })

  it("doesn't let our own readings explain a price move", async () => {
    const { policy, request } = await setupPolicy({ held: [], settings: unexplainedOn })
    await db.col.wireItems.insertOne(withRoot(item({ symbols: ["ETH/USD"], kind: "derivatives", category: "funding_extreme", first_seen_at: new Date(NOW.getTime() - 10 * 60_000), meta: { metric: "hyperliquid:funding:ETH/USD" } })))
    const move = withRoot(item({ kind: "anomaly", category: "price_shock", tier: 1, symbols: ["ETH/USD"], polarity: 1, severity: 63, meta: { anomaly: "price" } }))
    await policy.onItem({ item: move, backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ rule: "unexplained_move", symbol: "ETH/USD" }))
    const reading = withRoot(item({ symbols: ["ETH/USD"], kind: "derivatives", category: "funding_extreme", meta: { metric: "m" } }))
    expect(assembleDossier([reading, move], { symbols: ["ETH/USD"], since: new Date(NOW.getTime() - HOUR), now: NOW, price: () => null, timeLabel: () => "", reviewThreshold: 55 }).unexplained.map((i) => i._id)).toEqual([move._id])
  })
})

describe("dossier", () => {
  const o = { symbols: ["BTC/USD", "ETH/USD"], since: new Date(NOW.getTime() - 72 * HOUR), now: NOW, price: () => 81_200, timeLabel: (d: Date) => `${d.toISOString().slice(11, 16)}Z`, reviewThreshold: 55 }

  it("ranks, caps and fences items, and lists unexplained and unconfirmed ones", () => {
    const many = Array.from({ length: 12 }, (_, n) => withRoot(item({ title: `BTC story ${n}`, severity: 20 + n, url: `https://x.test/${n}`, price_at_seen: { "BTC/USD": 80_000 } })))
    const anomaly = withRoot(item({ kind: "anomaly", category: "price_shock", tier: 1, symbols: ["ETH/USD"], severity: 60, url: null, title: "ETH/USD +2% in 1 min" }))
    const loud = withRoot(item({ symbols: [], severity: 70, tier: 3, title: "Rumor: exchange insolvent", url: "https://rumor.test/a" }))
    const d = assembleDossier([...many, anomaly, loud], o)
    expect(d.text).toMatch(/^<untrusted source="wire">/)
    expect(d.text.match(/BTC story/g)).toHaveLength(8)
    expect(d.text).toContain("+1.5% since] BTC story 11 (https://x.test/11)")
    expect(d.unexplained.map((i) => i.title)).toEqual(["ETH/USD +2% in 1 min"])
    expect(d.unconfirmed.map((i) => i.title)).toEqual(["Rumor: exchange insolvent"])
    expect(d.urls.has("https://rumor.test/a")).toBe(true)
    expect(d.text).toMatch(/## Scheduled \(next 72 h\)\n.*FOMC/)
  })

  it("adds the checked machine summaries of the 8 best-ranked items, once each and capped", () => {
    const article = (summary: string, status: "ok" | "rejected" = "ok") => ({ status, summary, model: "llama3.2:3b", ms: 3_000, at: NOW })
    // In both symbol sections, so each is listed twice.
    const both = Array.from({ length: 10 }, (_, n) =>
      withRoot(item({ symbols: ["BTC/USD", "ETH/USD"], severity: 40 + n, title: `Story ${n}`, url: `https://x.test/${n}`, article: article(n === 9 ? `Summary 9 ${"x".repeat(2_000)}` : `Summary ${n}.`) })),
    )
    const market = Array.from({ length: 3 }, (_, n) => withRoot(item({ symbols: [], severity: 30, title: `Macro ${n}`, url: `https://m.test/${n}`, article: article(`Macro summary ${n}.`) })))
    const rejected = withRoot(item({ symbols: ["BTC/USD"], severity: 90, title: "Loud", url: "https://l.test/a", article: article("Invented 999.", "rejected") }))
    const d = assembleDossier([...both, ...market, rejected], o)
    expect(d.text.match(/\n> machine summary of the article: Summary \d/g)).toHaveLength(8)
    expect(d.text.match(/Summary 9 x/g)).toHaveLength(1)
    expect(d.text).toContain("Story 9 (https://x.test/9)\n> machine summary of the article: Summary 9 x")
    expect(d.text).not.toContain("Macro summary")
    expect(d.text).not.toContain("Invented")
    expect(Math.max(...d.text.split("\n").map((l) => l.length))).toBeLessThan(700)
  })

  it("lets the AI cite wire URLs and drops invented ones", () => {
    const n = normalizeCryptoReport(
      {
        market_read: { regime: "range", summary: "x", confidence: 50 },
        decisions: [
          {
            symbol: "BTC/USD",
            action: "hold",
            conviction: 50,
            uncertainty: "medium",
            p_target_first: null,
            stop_loss: null,
            take_profit: null,
            horizon_hours: 24,
            size_pct_of_max: null,
            reduce_pct: null,
            priced_in: "unknown",
            thesis: "t",
            bull_evidence: [{ claim: "c", kind: "sourced_claim", source_url: "https://x.test/1", as_of: null }],
            bear_evidence: [{ claim: "c", kind: "sourced_claim", source_url: "https://made.up/1", as_of: null }],
            risks: [],
            invalidation: "i",
          },
        ],
        data_gaps: [],
        notification: "n",
      },
      { candidates: new Set(), held: new Set(["BTC/USD"]), sourceUrls: new Set(["https://x.test/1"]) },
    )
    expect(n.decisions[0].bull_evidence[0]).toMatchObject({ verified_source: true })
    expect(n.decisions[0].bear_evidence[0]).toMatchObject({ verified_source: false, source_url: null })
  })
})

describe("research modes", () => {
  const ctxFor = (wire: Partial<Settings["wire"]>) => ({ settings: { current: { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, ...wire } }, version: 1 } as unknown as SettingsStore })
  const empty = assembleDossier([], { symbols: ["BTC/USD"], since: NOW, now: NOW, price: () => null, timeLabel: () => "", reviewThreshold: 55 })

  it("falls back to full research when the wire is off or unhealthy, and follows the mode otherwise", () => {
    expect(researchPlan(ctxFor({}), { isEvent: false, wireHealthy: true, dossier: null }).kind).toBe("full")
    expect(researchPlan(ctxFor({}), { isEvent: false, wireHealthy: false, dossier: empty }).kind).toBe("full")
    expect(researchPlan(ctxFor({ research_mode: "gap_fill" }), { isEvent: false, wireHealthy: true, dossier: empty }).kind).toBe("gap")
    expect(researchPlan(ctxFor({ event_research: "none" }), { isEvent: true, wireHealthy: true, dossier: empty }).kind).toBe("none")
    expect(researchPlan(ctxFor({}), { isEvent: true, wireHealthy: true, dossier: empty }).kind).toBe("gap")
  })

  it("auto runs the gap-fill for a gap on a candidate, a holding or the market, and skips Grok otherwise (no X-freshness rule)", () => {
    const moved = withRoot(item({ kind: "anomaly", category: "price_shock", tier: 1, symbols: ["ETH/USD"], url: null, meta: { anomaly: "price" } }))
    const rumor = withRoot(item({ symbols: ["SOL/USD"], tier: 3, url: "https://rumor.test/sol" }))
    const o = { symbols: ["ETH/USD", "SOL/USD"], since: new Date(NOW.getTime() - HOUR), now: NOW, price: () => null, timeLabel: () => "", reviewThreshold: 55 }
    const plan = (dossier: typeof empty) => researchPlan(ctxFor({ research_mode: "auto" }), { isEvent: false, wireHealthy: true, dossier })
    expect(plan(assembleDossier([moved], o))).toEqual({ kind: "gap", reason: "1 unexplained moves, 0 unconfirmed items" })
    expect(plan(assembleDossier([rumor], o))).toEqual({ kind: "gap", reason: "0 unexplained moves, 1 unconfirmed items" })
    expect(plan(empty)).toEqual({ kind: "none", reason: "no unexplained moves or unconfirmed items in our feeds" })
  })
})

describe("event cycle", () => {
  const setup = async () => {
    const bus = await makeBus(db.col)
    const ledger = new Ledger(db.col, bus)
    await ledger.ensureAccount(10_000)
    const hub = { ...fakeHub(), features: new Map() } as unknown as MarketHub
    const wallet = new FakeWallet()
    const executor = new Executor(db.col, ledger, new PaperWalletExecution(wallet.cli(), hub), bus, silentLogger)
    const path = (n: number) => Array.from({ length: n }, (_, i) => 50_000 + (15_000 * i) / (n - 1))
    const candleCache = { get: async (_s: string, interval: number) => candles(path(250), interval * 60_000, Date.now() - 250 * interval * 60_000) } as unknown as CandleCache
    // The fake model reports progress the way the streamed runner does.
    const research = vi.fn(async (o: { progress?: ResearchProgress }) => {
      o.progress?.onReasoning?.(31, "Checking X for the ETF inflows.")
      return { memo: "## X sentiment\nPositive.", sources: [], queries: [], model: "m", x_search: true, duration_ms: 1, usage: { input: 0, output: 0, total: 0 }, cost_usd: 0.02, error: null }
    })
    const structured = vi.fn(async (o: { progress?: StructuredProgress }) => {
      o.progress?.onReasoning?.(40, "The inflows look real; funding is calm.")
      o.progress?.onPartial?.(180, { market_read: { regime: "risk_on_trend", summary: "Event checked." }, decisions: [{ symbol: "BTC/USD", action: "bu" }] })
      return {
        output: {
          market_read: { regime: "risk_on_trend" as const, summary: "Event checked.", confidence: 60 },
          decisions: [
            {
              symbol: "BTC/USD",
              action: "buy" as const,
              conviction: 72,
              uncertainty: "medium" as const,
              p_target_first: 0.5,
              stop_loss: 63_000,
              take_profit: 70_000,
              horizon_hours: 24,
              size_pct_of_max: 50,
              reduce_pct: null,
              priced_in: "partially" as const,
              thesis: "Confirmed catalyst.",
              bull_evidence: [],
              bear_evidence: [{ claim: "Could fade", kind: "speculation" as const, source_url: null, as_of: null }],
              risks: [],
              invalidation: "Back below 63k",
            },
          ],
          data_gaps: [],
          notification: "Buying BTC on the event",
        },
        attempts: 1,
        repaired: false,
        model: "m",
        cost_usd: 0.03,
        usage: { input: 0, output: 0, total: 0 },
      }
    })
    const ctx: EngineContext = {
      col: db.col,
      log: silentLogger,
      bus,
      settings: { current: { ...DEFAULT_SETTINGS, universe: { kraken_symbols: ["BTC/USD"] } }, version: 1 } as unknown as SettingsStore,
      state: { state: { status: "running", kill_switch: { engaged: false } } } as unknown as EngineStateStore,
      hub,
      candles: candleCache,
      ledger,
      executor,
      ai: { available: true, research, structured } as unknown as AiRunner,
      alerts: { send: vi.fn(), success: vi.fn() } as unknown as Alerts,
      gate: () => ({ runStatus: "running", killSwitch: false, venueOnline: true, reconciled: true }),
      feeBps: () => 40,
      setCycleState: () => undefined,
      signal: new AbortController().signal,
    }
    const focus: EventFocus = { symbol: "BTC/USD", rule: "entry_event", action: "evaluate", severity: 78, polarity: 1, item_ids: ["item-1"], trigger_id: "trig-1", headline: "Spot ETF inflows hit a record" }
    return { bus, ctx, research, structured, focus }
  }

  it("turns a bullish focus into an event_driven candidate and reaches the risk engine", async () => {
    const { ctx, research, structured, focus } = await setup()
    expect(eventCandidates([focus, { ...focus, polarity: -1, symbol: "ETH/USD" }], [], new Set(), ctx.settings.current)).toEqual([])
    const r = await runCryptoCycle(ctx, { kind: "event", trigger: "event: entry event BTC/USD", events: [focus] })
    expect(r.status).toBe("completed")
    expect(research).toHaveBeenCalledWith(expect.objectContaining({ task: "research_gap", prompt: expect.stringContaining("THIS CYCLE WAS STARTED BY AN EVENT") }))
    expect((structured.mock.calls[0] as unknown[])[0]).toMatchObject({ prompt: expect.stringContaining("# EVENT (why this cycle started)"), timeoutMs: 90_000 })
    const decision = await db.col.decisions.findOne({ symbol: "BTC/USD" })
    expect(decision).toMatchObject({ trigger_kind: "event", strategy_id: "event_driven", wire_item_ids: ["item-1"] })
    expect(decision!.risk?.checks.map((c) => c.name)).toContain("edge_after_costs")
    expect(await db.col.cycles.findOne({ _id: r.cycleId })).toMatchObject({ kind: "event", wire_trigger_id: "trig-1", wire_item_ids: ["item-1"], research_plan: { kind: "gap", reason: "event check (x_verify)" } })
  })

  it("records which research it ran and why, also when it skips Grok", async () => {
    const { ctx, research, focus } = await setup()
    ctx.settings = { current: { ...ctx.settings.current, wire: { ...ctx.settings.current.wire, event_research: "none" } }, version: 1 } as unknown as SettingsStore
    const r = await runCryptoCycle(ctx, { kind: "event", trigger: "event: entry event BTC/USD", events: [focus] })
    expect(r.status).toBe("completed")
    expect(research).not.toHaveBeenCalled()
    const reason = "event cycle with event_research none: the dossier is the evidence"
    expect(await db.col.cycles.findOne({ _id: r.cycleId })).toMatchObject({ research_plan: { kind: "none", reason }, research_skip_reason: reason })
  })

  it("streams the model's reasoning and the decision as it's written, tagged with the cycle and never stored", async () => {
    const { bus, ctx, focus } = await setup()
    const events: EngineEvent[] = []
    bus.subscribe((e) => events.push(e))
    const r = await runCryptoCycle(ctx, { kind: "event", trigger: "event: entry event BTC/USD", events: [focus] })
    expect(r.status).toBe("completed")
    const types = events.map((e) => e.type).filter((t) => t.startsWith("research.") || t.startsWith("ai."))
    expect(types.slice(0, 6)).toEqual(["research.started", "ai.reasoning", "research.completed", "ai.decision.started", "ai.reasoning", "ai.decision.progress"])
    const live = events.filter((e) => e.type === "ai.reasoning" || e.type === "ai.decision.progress")
    expect(live.map((e) => [e.type, e.summary, e.data])).toEqual([
      ["ai.reasoning", "Reasoning (research)", { cycle_id: r.cycleId, task: "research", chars: 31, excerpt: "Checking X for the ETF inflows." }],
      ["ai.reasoning", "Reasoning (decision)", { cycle_id: r.cycleId, task: "decision", chars: 40, excerpt: "The inflows look real; funding is calm." }],
      ["ai.decision.progress", "Writing: “Event checked.” · 1 decision so far", { cycle_id: r.cycleId, chars: 180, headline: "Event checked.", decisions: 1 }],
    ])
    // Debug level, tagged with the cycle, and ephemeral: streamed to live views (seq 0), never written to `events`.
    expect(live.every((e) => e.level === "debug" && e.cycle_id === r.cycleId && e.seq === 0)).toBe(true)
    await bus.flush()
    expect(await db.col.events.countDocuments({ type: { $in: ["ai.reasoning", "ai.decision.progress"] } })).toBe(0)
    expect(await db.col.events.countDocuments({ type: "ai.decision.started", cycle_id: r.cycleId })).toBe(1)
  })
})
