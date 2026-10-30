import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import type { EventFocus, WireItemDoc } from "@mb/crypto-core/wire"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import { cryptoRules, WirePolicy } from "../src/wire/policy"
import { useTestDb } from "./helpers/db"
import { makeBus } from "./helpers/fakes"

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
  const request = vi.fn<(f: EventFocus) => "fired" | "queued" | "agent">(() => "fired")
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

  it("records a trigger the engine leaves to the agent (level auto) as handed to it", async () => {
    const { policy, request } = await setupPolicy()
    request.mockReturnValue("agent")
    await policy.onItem({ item: withRoot(item({ polarity: -1, severity: 62, category: "regulatory_action" })), backfill: false, confirmation: false })
    expect(await triggers()).toEqual([expect.objectContaining({ rule: "held_negative", status: "fired", reason: "handed to the agent" })])
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
  })
})
