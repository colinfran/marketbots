import { silentLogger } from "@mb/engine-kit/log"
import { DEFAULT_SETTINGS, type Settings } from "@mb/stock-core/settings"
import type { EventFocus, WireItemDoc } from "@mb/stock-core/wire"
import { describe, expect, it, vi } from "vitest"
import { stockRules, WirePolicy } from "../../src/wire/policy"
import { makeBus } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"

const db = useTestDb()
const NOW = new Date("2026-10-27T15:00:00Z")

const item = (overrides: Partial<WireItemDoc> = {}): WireItemDoc => {
  const id = `i-${Math.random().toString(36).slice(2, 10)}`
  return {
    _id: id,
    cluster_id: id,
    source: "edgar:8k",
    tier: 1,
    kind: "filing",
    category: "general",
    title: "Something",
    summary: null,
    url: "https://sec.gov/x",
    domain: "sec.gov",
    symbols: ["NVDA"],
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
  }
}

const setup = async ({ held = ["NVDA"], open = true, settings = DEFAULT_SETTINGS, observe }: { held?: string[]; open?: boolean; settings?: Settings; observe?: (item: unknown, c: { rule: string }) => void } = {}) => {
  const bus = await makeBus(db.col)
  const request = vi.fn<(f: EventFocus) => "fired" | "queued">(() => "fired")
  const alert = vi.fn(async () => undefined)
  const emergency = vi.fn(async () => "selling")
  const policy = new WirePolicy({
    col: db.col,
    bus,
    log: silentLogger,
    settings: () => settings,
    rules: stockRules,
    engine: () => ({ running: true, killSwitch: false }),
    session: () => ({ open, reason: open ? "regular session" : "outside the regular session" }),
    held: () => held,
    universe: () => ["SPY", "AAPL"],
    request,
    markNotable: async () => undefined,
    emergency,
    alert,
    observe,
    now: () => NOW,
  })
  return { policy, request, alert, emergency, bus }
}
const triggers = () => db.col.wireTriggers.find({}).toArray()

describe("stock policy", () => {
  it("lets the agent observe news while the market is closed", async () => {
    const observe = vi.fn()
    const a = await setup({ open: false, observe })
    await a.policy.onItem({ item: item({ category: "restatement", severity: 90, title: "NVDA 8-K: 4.02 Non-Reliance" }), backfill: false, confirmation: false })
    expect(a.request).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ title: "NVDA 8-K: 4.02 Non-Reliance" }), expect.objectContaining({ rule: "held_negative", symbols: ["NVDA"] }))
    await a.bus.stop()
  })

  it("reviews a holding on a negative filing in session, and alerts instead when the market is closed", async () => {
    const a = await setup()
    await a.policy.onItem({ item: item({ category: "restatement", severity: 90, title: "NVDA 8-K: 4.02 Non-Reliance" }), backfill: false, confirmation: false })
    expect(a.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "NVDA", rule: "held_negative", action: "review" }))
    await a.bus.stop()

    await db.col.wireTriggers.deleteMany({})
    const b = await setup({ open: false })
    await b.policy.onItem({ item: item({ category: "offering", severity: 65, polarity: -1 }), backfill: false, confirmation: false })
    expect(b.request).not.toHaveBeenCalled()
    expect(b.alert).toHaveBeenCalledWith(expect.stringContaining("market closed"), expect.any(String))
    expect((await triggers())[0]).toMatchObject({ status: "suppressed", reason: expect.stringContaining("market closed") })
    await b.bus.stop()
  })

  it("evaluates confirmed good news on a stock we don't hold, and checks unexplained movers only when unexplained_move_entries is on", async () => {
    const { policy, request, bus } = await setup({ held: [] })
    await policy.onItem({ item: item({ symbols: ["AAPL"], category: "m_and_a", polarity: 1, severity: 75, tier: 1, title: "AAPL to be acquired" }), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAPL", action: "evaluate" }))
    request.mockClear()
    const mover = () => item({ symbols: ["ACME"], kind: "anomaly", category: "price_shock", polarity: 1, severity: 60, meta: { anomaly: "mover" } })
    await policy.onItem({ item: mover(), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect((await triggers()).map((t) => t.rule)).not.toContain("unexplained_move")
    await bus.stop()

    const on = await setup({ held: [], settings: { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, unexplained_move_entries: true } } })
    await on.policy.onItem({ item: mover(), backfill: false, confirmation: false })
    expect(on.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "ACME", rule: "unexplained_move", action: "gap_fill" }))
    await on.bus.stop()
  })

  it("alerts on a halt of a holding and reviews on the resumption", async () => {
    const { policy, request, alert, bus } = await setup()
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: -1, meta: { resumes_at: null } }), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledOnce()
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: 0, meta: { resumes_at: "10:15:00" } }), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "NVDA", rule: "halt", action: "review" }))
    await bus.stop()
  })

  it("annotates odds, attention, insider clusters, congressional trades and our own readings; only a critical odds swing reviews what we hold", async () => {
    const a = await setup()
    const swing = (severity: number) => item({ source: "odds:kalshi", tier: 2, kind: "sentiment", category: "odds_swing", symbols: [], severity, meta: { metric: `kalshi:KXFED-26DEC-T4.25:${severity}` } })
    await a.policy.onItem({ item: swing(60), backfill: false, confirmation: false })
    expect(a.request).not.toHaveBeenCalled()
    await a.policy.onItem({ item: swing(90), backfill: false, confirmation: false })
    expect(a.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: null, rule: "odds_swing", action: "market_review" }))
    a.request.mockClear()
    for (const context of [
      // An insider cluster is context, even when loud and positive.
      item({ source: "insiders", tier: 2, kind: "filing", category: "insider_buy", symbols: ["AAPL"], polarity: 1, severity: 80, meta: { insider: true, cluster: true } }),
      // A congressional trade is weeks old when it is disclosed: a purchase of a stock we could buy, a sale of one we hold.
      item({ source: "congress:house", tier: 3, kind: "filing", category: "general", symbols: ["AAPL"], polarity: 1, severity: 80, meta: { congress: true, transaction: "purchase" } }),
      item({ source: "congress:house", tier: 3, kind: "filing", category: "general", symbols: ["NVDA"], polarity: -1, severity: 80, meta: { congress: true, transaction: "sale" } }),
      item({ source: "vol_rates:vix", kind: "derivatives", category: "price_shock", symbols: [], polarity: -1, severity: 70, meta: { metric: "vix" } }),
      item({ source: "treasury", kind: "macro", category: "macro_release", symbols: [], polarity: -1, severity: 60, meta: { metric: "treasury:auction:10-Year" } }),
      item({ source: "finra_short", kind: "derivatives", category: "general", symbols: ["NVDA"], polarity: 0, severity: 60, meta: { metric: "finra_short:NVDA" } }),
      item({ source: "stocktwits", tier: 3, kind: "sentiment", category: "sentiment_spike", symbols: ["NVDA"], polarity: -1, severity: 70 }),
    ]) {
      await a.policy.onItem({ item: context, backfill: false, confirmation: false })
    }
    expect(a.request).not.toHaveBeenCalled()
    expect((await triggers()).map((t) => t.rule)).toEqual(["odds_swing"])
    await a.bus.stop()

    // With nothing held, even a critical swing is only context.
    await db.col.wireTriggers.deleteMany({})
    const b = await setup({ held: [] })
    await b.policy.onItem({ item: swing(95), backfill: false, confirmation: false })
    expect(b.request).not.toHaveBeenCalled()
    expect(await triggers()).toEqual([])
    await b.bus.stop()
  })

  it("runs the exit emergency action only on critical confirmed bad news", async () => {
    const exit = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, emergency_action: "exit" as const } }
    const { policy, emergency, bus } = await setup({ settings: exit })
    await policy.onItem({ item: item({ category: "bankruptcy", severity: 95, polarity: -1 }), backfill: false, confirmation: false })
    expect(emergency).toHaveBeenCalledWith("NVDA", expect.anything())
    await bus.stop()
  })
})
