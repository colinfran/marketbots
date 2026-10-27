import type { ChainContract } from "@mb/stock-core/context"
import type { EngineEvent } from "@mb/stock-core/events"
import type { Decision } from "@mb/stock-core/report"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import { executeDecisions } from "../../src/bot/execute"
import { evaluateOptionEntry, exitTrigger, liquidateOptions, monitorOptions, reconcileOptions, type OptionEntryInput } from "../../src/bot/options"
import { computeRiskState } from "../../src/bot/risk"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { account, afterOpen, decision, NVDA_CALL_140, NVDA_CALL_150, NVDA_PUT_120, NVDA_PUT_130, optionPositionDoc, report } from "../helpers/factories"
import { settle, useFakeClock } from "../helpers/timers"

const NOW = afterOpen(90) // Monday 2026-10-26, 11:00 ET
const db = useTestDb()
let broker: FakeBroker
let ctx: EngineContext
let bus: EventBus
let events: EngineEvent[]
let alerts: SentAlert[]

const contract = (symbol: string, overrides: Partial<ChainContract> = {}): ChainContract => {
  const call = symbol.includes("C0")
  const strike = Number(symbol.slice(-8)) / 1000
  return { symbol, type: call ? "call" : "put", expiration: "2026-11-20", dte: 25, strike, bid: 5.9, ask: 6.1, mid: 6, spread_pct: 3.3, delta: call ? 0.52 : -0.48, iv: 0.45, open_interest: 5_000, ...overrides }
}

const optionDecision = (overrides: Partial<Decision> = {}, option: Partial<NonNullable<Decision["option"]>> = {}): Decision =>
  decision({
    symbol: "NVDA",
    action: "buy_option",
    allocation_pct: null,
    conviction: 8,
    horizon: "multi_day",
    rationale: "Breakout into earnings with call flow.",
    option: { strategy: "long_call", long_leg: NVDA_CALL_140, short_leg: null, premium_pct: 2, stop_loss_pct: null, take_profit_pct: null, ...option },
    ...overrides,
  })

beforeEach(async () => {
  useFakeClock(NOW)
  broker = fakeBroker()
  ;({ ctx, bus, events, alerts } = await makeCtx(db.col, broker))
  broker.setPrice("NVDA", 142)
  ctx.prices.onTrade("NVDA", 142, NOW.getTime())
  broker.setOptionQuote(NVDA_CALL_140, { bid: 5.9, ask: 6.1, delta: 0.52 })
  broker.setOptionQuote(NVDA_CALL_150, { bid: 2.4, ask: 2.6, delta: 0.3 })
  broker.setOptionQuote(NVDA_PUT_130, { bid: 3.9, ask: 4.1, delta: -0.32 })
  broker.setOptionQuote(NVDA_PUT_120, { bid: 1.4, ask: 1.6, delta: -0.18 })
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

// ─── Entry rules ─────────────────────────────────────────────────────────────

describe("evaluateOptionEntry", () => {
  const input = (overrides: Partial<OptionEntryInput> = {}): OptionEntryInput => ({
    decision: optionDecision(),
    phase: "intraday",
    settings: DEFAULT_SETTINGS,
    risk: computeRiskState(account(), 0, 0, DEFAULT_SETTINGS),
    entriesBlocked: null,
    tradesLeft: 30,
    openPositions: 0,
    premiumOpenUsd: 0,
    optionsBuyingPower: 10_000,
    long: contract(NVDA_CALL_140),
    short: undefined,
    underlyingPrice: 142,
    ...overrides,
  })

  it("sizes a long call within the per-trade premium cap, priced between the mid and the ask", () => {
    const r = evaluateOptionEntry(input())
    // limit = 6 + 0.5 × (6.1 − 6) = 6.05 → $605 per contract; 2% of $10,000 = $200 buys 0.
    expect(r).toMatchObject({ approved: false, reason: "budget $200 buys less than 1 contract at $605" })
    const cheap = evaluateOptionEntry(input({ long: contract(NVDA_CALL_140, { bid: 1.9, ask: 2.1, mid: 2 }) }))
    expect(cheap).toMatchObject({ approved: false, limit: 0, reason: "budget $200 buys less than 1 contract at $205" })
  })

  it("approves a sized position and records every check", () => {
    const r = evaluateOptionEntry(input({ decision: optionDecision({}, { premium_pct: 2 }), long: contract(NVDA_CALL_140, { bid: 0.95, ask: 1.05, mid: 1 }) }))
    expect(r).toMatchObject({ approved: true, contracts: 1, limit: 1.03, cost: 103, maxProfit: null })
    expect(r.checks.map((c) => c.name)).toEqual([
      "engine",
      "options enabled",
      "loss limits",
      "phase",
      "conviction",
      "open options positions",
      "trades today",
      "order",
      "strategy",
      "long leg offered",
      "underlying",
      "contract type",
      "days to expiration",
      "delta",
      "liquidity 140C",
      "underlying price",
      "net debit",
      "premium budget",
    ])
    expect(r.checks.every((c) => c.ok)).toBe(true)
  })

  it("prices and caps a debit spread by its width", () => {
    const r = evaluateOptionEntry(
      input({
        decision: optionDecision({}, { strategy: "call_debit_spread", short_leg: NVDA_CALL_150, premium_pct: 5 }),
        settings: { ...DEFAULT_SETTINGS, options: { ...DEFAULT_SETTINGS.options, max_premium_per_trade_pct: 5 } },
        short: contract(NVDA_CALL_150, { bid: 2.4, ask: 2.6, mid: 2.5, delta: 0.3 }),
      }),
    )
    // Net mid 3.5, net at the ask 3.7 → limit 3.6; width 10 → max profit 6.4 per share.
    expect(r).toMatchObject({ approved: true, limit: 3.6, contracts: 1, cost: 360, maxProfit: 640 })
    expect(r.checks.find((c) => c.name === "reward:risk")).toMatchObject({ ok: true })
  })

  it.each<[string, Partial<OptionEntryInput>, string]>([
    ["the engine is halted", { entriesBlocked: "kill switch engaged: x" }, "kill switch engaged: x"],
    ["options are off", { settings: { ...DEFAULT_SETTINGS, options: { ...DEFAULT_SETTINGS.options, enabled: false } } }, "options trading is disabled in settings"],
    ["conviction is low", { decision: optionDecision({ conviction: 6 }) }, "conviction 6 < 7"],
    ["too many are open", { openPositions: 4 }, "max 4 options positions reached"],
    ["the contract wasn't offered", { long: undefined }, `${NVDA_CALL_140} wasn't in the option chains offered this cycle`],
    ["it's a put for a call strategy", { long: contract(NVDA_PUT_130) }, "Long call needs a call, got a put"],
    ["delta is out of range", { long: contract(NVDA_CALL_140, { delta: 0.15 }) }, "|delta| 0.15 is outside 0.3-0.7"],
    ["expiration is too close", { long: contract(NVDA_CALL_140, { dte: 5 }) }, "5 days to expiration is outside 14-45"],
    ["the market is too wide", { long: contract(NVDA_CALL_140, { spread_pct: 25 }) }, "too illiquid: spread 25% (max 10%), open interest 5000 (min 500)"],
    ["it's the closing window without high conviction", { phase: "close" }, "closing-window options entries need conviction >= 8"],
  ])("rejects when %s", (_label, overrides, reason) => {
    const d = overrides.phase === "close" ? { decision: optionDecision({ conviction: 7 }) } : {}
    expect(evaluateOptionEntry(input({ ...d, ...overrides }))).toMatchObject({ approved: false, reason })
  })

  it("rejects spreads with the wrong shape", () => {
    const spread = (short: ChainContract | undefined) =>
      evaluateOptionEntry(input({ decision: optionDecision({}, { strategy: "call_debit_spread", short_leg: short?.symbol ?? NVDA_CALL_150 }), short }))
    expect(spread(undefined).reason).toBe(`${NVDA_CALL_150} wasn't in the option chains offered this cycle`)
    expect(spread(contract("NVDA261120C00130000", { strike: 130 })).reason).toBe("a call debit spread sells a HIGHER strike than it buys")
    expect(spread(contract(NVDA_CALL_150, { expiration: "2026-12-18" })).reason).toBe("both legs must be the same type and expiration")
    const noSpreads = { ...DEFAULT_SETTINGS, options: { ...DEFAULT_SETTINGS.options, allow_spreads: false } }
    expect(evaluateOptionEntry(input({ settings: noSpreads, decision: optionDecision({}, { strategy: "put_debit_spread", long_leg: NVDA_PUT_130, short_leg: NVDA_PUT_120 }) })).reason).toBe("spreads are disabled in settings")
  })

  it("drops underlying levels on the wrong side of the price", () => {
    const r = evaluateOptionEntry(input({ decision: optionDecision({ stop_loss: 150, take_profit: 130 }), long: contract(NVDA_CALL_140, { bid: 0.95, ask: 1.05, mid: 1 }) }))
    expect(r).toMatchObject({ approved: true, underlyingStop: null, underlyingTarget: null })
    expect(r.notes).toEqual(["underlying stop 150 is on the wrong side of 142; ignored", "underlying target 130 is on the wrong side of 142; ignored"])
  })

  it("keeps total premium under the overall cap", () => {
    const r = evaluateOptionEntry(input({ premiumOpenUsd: 1_450, long: contract(NVDA_CALL_140, { bid: 0.95, ask: 1.05, mid: 1 }) }))
    // 15% of 10,000 = 1,500 total; 50 left buys nothing at $103.
    expect(r).toMatchObject({ approved: false, reason: "budget $50 buys less than 1 contract at $103" })
  })
})

// ─── Exit rules ──────────────────────────────────────────────────────────────

describe("exitTrigger", () => {
  const doc = optionPositionDoc({ entry_price: 5, underlying_stop: 135, underlying_target: 160 })
  const at = { today: "2026-10-26", nowEt: "11:00", closeAtDte: 1 }
  const quote = (mid: number) => ({ mid, exitValue: mid - 0.1, entryValue: mid + 0.1, delta: 0.5 })

  it("holds while nothing is hit", () => {
    expect(exitTrigger(doc, quote(5.5), 142, at)).toBeNull()
  })

  it("stops out on value, the underlying's invalidation, and time", () => {
    expect(exitTrigger(doc, quote(2.5), 142, at)).toMatchObject({ kind: "stop", urgent: true })
    expect(exitTrigger(doc, quote(5), 134.9, at)).toMatchObject({ kind: "underlying_stop", urgent: true })
    expect(exitTrigger(doc, quote(5), 142, { ...at, today: "2026-11-19" })).toMatchObject({ kind: "time", detail: "1 day to expiration" })
    // Not in the first half hour: spreads are wide at the open.
    expect(exitTrigger(doc, quote(5), 142, { ...at, today: "2026-11-19", nowEt: "09:45" })).toBeNull()
  })

  it("takes profit on value or the underlying's target", () => {
    expect(exitTrigger(doc, quote(10), 142, at)).toMatchObject({ kind: "target", urgent: false })
    expect(exitTrigger(doc, quote(6), 160, at)).toMatchObject({ kind: "underlying_target", urgent: false })
  })

  it("mirrors the levels for bearish positions", () => {
    const put = optionPositionDoc({ strategy: "long_put", entry_price: 4, underlying_stop: 150, underlying_target: 125 })
    expect(exitTrigger(put, quote(4), 151, at)).toMatchObject({ kind: "underlying_stop" })
    expect(exitTrigger(put, quote(4), 124, at)).toMatchObject({ kind: "underlying_target" })
    expect(exitTrigger(put, quote(4), 142, at)).toBeNull()
  })

  it("caps a spread's target just below its width", () => {
    const spread = optionPositionDoc({
      strategy: "call_debit_spread",
      entry_price: 4,
      take_profit_pct: 200,
      legs: [
        { symbol: NVDA_CALL_140, type: "call", strike: 140, expiration: "2026-11-20", side: "long", fill_price: 6 },
        { symbol: NVDA_CALL_150, type: "call", strike: 150, expiration: "2026-11-20", side: "short", fill_price: 2 },
      ],
    })
    expect(exitTrigger(spread, quote(9.4), 142, at)).toBeNull()
    expect(exitTrigger(spread, quote(9.5), 142, at)).toMatchObject({ kind: "target", detail: expect.stringContaining("target 9.50") })
  })
})

// ─── Execution through executeDecisions ──────────────────────────────────────

const execute = (decisions: Decision[], chains: ChainContract[]) =>
  settle(executeDecisions(ctx, { cycleId: "cycle-1", reportId: "rep-1", phase: "intraday", report: report({ decisions }), chains: new Map(chains.map((c) => [c.symbol, c])), entriesBlocked: () => null }))

describe("opening options positions", () => {
  it("buys a long call with a day limit order and records the position", async () => {
    // A cheaper contract so 2% of equity buys one.
    broker.setOptionQuote(NVDA_CALL_150, { bid: 0.95, ask: 1.05, delta: 0.35 })
    const summary = await execute([optionDecision({ stop_loss: 135, take_profit: 160 }, { long_leg: NVDA_CALL_150 })], [contract(NVDA_CALL_150, { bid: 0.95, ask: 1.05, mid: 1, delta: 0.35 })])
    expect(summary).toMatchObject({ executed: 1, rejected: 0, failed: 0 })
    expect(broker.submitted).toEqual([
      { symbol: NVDA_CALL_150, qty: "1", side: "buy", type: "limit", limit_price: "1.03", time_in_force: "day", position_intent: "buy_to_open", client_order_id: expect.stringMatching(/^smb-opt-buy-/) },
    ])
    const position = (await db.col.optionPositions.findOne({}))!
    expect(position).toMatchObject({
      underlying: "NVDA",
      strategy: "long_call",
      status: "open",
      qty: 1,
      entry_price: 1.03,
      cost_usd: 103,
      max_loss_usd: 103,
      stop_loss_pct: 50,
      take_profit_pct: 100,
      underlying_stop: 135,
      underlying_target: 160,
      expiration: "2026-11-20",
      legs: [expect.objectContaining({ symbol: NVDA_CALL_150, side: "long", fill_price: 1.03 })],
    })
    const record = (await db.col.decisions.findOne({ action: "buy_option" }))!
    expect(record).toMatchObject({ instrument: "option", status: "executed", reason: "bought 1 contract at $1.03 ($103)", option: { structure_id: position._id, strategy: "long_call", contracts: 1 } })
    expect(await db.col.orders.findOne({ structure_id: position._id })).toMatchObject({ asset_class: "us_option", underlying: "NVDA", decision_id: record._id })
    expect(events.find((e) => e.type === "position.opened")).toMatchObject({ instrument: "NVDA", data: { asset_class: "us_option", qty: 1, structure_id: position._id } })
  })

  it("buys a debit spread as one two-leg order", async () => {
    ctx.settings.current.options.max_premium_per_trade_pct = 5
    await execute(
      [optionDecision({}, { strategy: "call_debit_spread", short_leg: NVDA_CALL_150, premium_pct: 5 })],
      [contract(NVDA_CALL_140), contract(NVDA_CALL_150, { bid: 2.4, ask: 2.6, mid: 2.5, delta: 0.3 })],
    )
    expect(broker.submitted).toEqual([
      {
        order_class: "mleg",
        qty: "1",
        type: "limit",
        limit_price: "3.60",
        time_in_force: "day",
        legs: [
          { symbol: NVDA_CALL_140, ratio_qty: "1", side: "buy", position_intent: "buy_to_open" },
          { symbol: NVDA_CALL_150, ratio_qty: "1", side: "sell", position_intent: "sell_to_open" },
        ],
        client_order_id: expect.stringMatching(/^smb-opt-buy-/),
      },
    ])
    // Legs fill at their mids: 6 − 2.5 = 3.5 per share.
    expect(await db.col.optionPositions.findOne({})).toMatchObject({ strategy: "call_debit_spread", status: "open", entry_price: 3.5, cost_usd: 350, max_profit_usd: 650 })
    expect(broker.holdings.get(NVDA_CALL_140)?.qty).toBe(1)
    expect(broker.holdings.get(NVDA_CALL_150)?.qty).toBe(-1)
  })

  it("cancels an entry that doesn't fill in time and keeps no position", async () => {
    ctx.settings.current.options.entry_aggression = 0
    broker.setOptionQuote(NVDA_CALL_150, { bid: 0.95, ask: 1.05, delta: 0.35 })
    // The quote moves up after the menu was built: a limit at the old midpoint no longer fills.
    const stale = contract(NVDA_CALL_150, { bid: 0.85, ask: 0.95, mid: 0.9, delta: 0.35 })
    const summary = await execute([optionDecision({}, { long_leg: NVDA_CALL_150 })], [stale])
    expect(summary.noop).toBe(1)
    expect((await db.col.decisions.findOne({}))!.reason).toBe("not filled at $0.90 within 30s; canceled")
    expect(await db.col.optionPositions.countDocuments()).toBe(0)
    expect(broker.allOrders()[0].status).toBe("canceled")
  })

  it("records rejected entries with every check, and places nothing", async () => {
    await execute([optionDecision({ conviction: 5 })], [contract(NVDA_CALL_140)])
    const record = (await db.col.decisions.findOne({}))!
    expect(record).toMatchObject({ status: "rejected", reason: "conviction 5 < 7" })
    expect(record.checks.at(-1)).toMatchObject({ name: "conviction", ok: false })
    expect(broker.submitted).toEqual([])
    expect(events.find((e) => e.type === "risk.checked")).toMatchObject({ data: { approved: false, reasons: ["conviction 5 < 7"] } })
  })
})

describe("managing options positions", () => {
  const openCall = async (overrides: Parameters<typeof optionPositionDoc>[0] = {}) => {
    broker.setPosition(NVDA_CALL_140, 1, 6, { avg: 5 })
    const doc = optionPositionDoc({ entry_price: 5, opened_at: afterOpen(-1_000), ...overrides })
    await db.col.optionPositions.insertOne(doc)
    return doc
  }

  it("closes a position the AI wants out of, with a limit first", async () => {
    const doc = await openCall()
    await execute([decision({ symbol: "NVDA", action: "close_option", structure_id: doc._id })], [])
    expect(broker.submitted).toEqual([expect.objectContaining({ symbol: NVDA_CALL_140, side: "sell", type: "limit", position_intent: "sell_to_close" })])
    expect(await db.col.optionPositions.findOne({ _id: doc._id })).toMatchObject({ status: "closed", exit_reason: "ai", exit_price: 5.95, realized_pnl_usd: 95 })
    expect((await db.col.decisions.findOne({}))!.reason).toBe("closed 1 at $5.95, realized +$95.00")
    expect(events.find((e) => e.type === "position.closed")).toMatchObject({ data: { realized_pnl_usd: 95, reason: "ai", structure_id: doc._id } })
  })

  it("tightens the underlying stop on hold_option but never loosens it", async () => {
    const doc = await openCall({ underlying_stop: 135 })
    await execute([decision({ symbol: "NVDA", action: "hold_option", structure_id: doc._id, stop_loss: 138, take_profit: 165 })], [])
    expect(await db.col.optionPositions.findOne({ _id: doc._id })).toMatchObject({ underlying_stop: 138, underlying_target: 165 })
    expect((await db.col.decisions.findOne({}))!.reason).toBe("holding; underlying stop 135 → 138; underlying target → 165")
    await db.col.decisions.deleteMany({})
    await execute([decision({ symbol: "NVDA", action: "hold_option", structure_id: doc._id, stop_loss: 130 })], [])
    expect((await db.col.optionPositions.findOne({ _id: doc._id }))!.underlying_stop).toBe(138)
  })

  it("rejects managing a position that doesn't exist", async () => {
    await execute([decision({ symbol: "NVDA", action: "close_option", structure_id: "nope" })], [])
    expect(await db.col.decisions.findOne({})).toMatchObject({ status: "rejected", reason: "no open options position nope" })
  })

  it("marks positions to market and closes them at market when a stop hits", async () => {
    const doc = await openCall()
    expect(await settle(monitorOptions(ctx, { marketOpen: true }))).toEqual([])
    expect((await db.col.optionPositions.findOne({ _id: doc._id }))!.mark).toMatchObject({ value: 6, exit_value: 5.9, pnl_usd: 100, pnl_pct: 20, underlying_price: 142, delta: 0.52 })

    broker.setOptionQuote(NVDA_CALL_140, { bid: 2.3, ask: 2.5, delta: 0.3 })
    const notes = await settle(monitorOptions(ctx, { marketOpen: true }))
    expect(notes).toEqual(["NVDA stop: closed 1 at $2.30, realized −$270.00"])
    expect(broker.submitted.at(-1)).toMatchObject({ symbol: NVDA_CALL_140, side: "sell", type: "market" })
    expect(await db.col.optionPositions.findOne({ _id: doc._id })).toMatchObject({ status: "closed", exit_reason: "stop", realized_pnl_usd: -270 })
    expect(events.find((e) => e.type === "protection.triggered")).toMatchObject({ data: { kind: "stop", structure_id: doc._id } })
  })

  it("only marks positions while the market is closed", async () => {
    await openCall()
    broker.setOptionQuote(NVDA_CALL_140, { bid: 1, ask: 1.2 })
    expect(await settle(monitorOptions(ctx, { marketOpen: false }))).toEqual([])
    expect(broker.submitted).toEqual([])
  })

  it("closes spreads with a two-leg order", async () => {
    broker.setPosition(NVDA_CALL_140, 1, 6, { avg: 6 })
    broker.setPosition(NVDA_CALL_150, -1, 2.5, { avg: 2.5, side: "short" })
    const doc = optionPositionDoc({
      strategy: "call_debit_spread",
      entry_price: 3.5,
      legs: [
        { symbol: NVDA_CALL_140, type: "call", strike: 140, expiration: "2026-11-20", side: "long", fill_price: 6 },
        { symbol: NVDA_CALL_150, type: "call", strike: 150, expiration: "2026-11-20", side: "short", fill_price: 2.5 },
      ],
    })
    await db.col.optionPositions.insertOne(doc)
    const notes = await settle(liquidateOptions(ctx, "kill_switch"))
    expect(notes).toEqual(["NVDA call debit spread: closed 1 at $3.50, realized +$0.00"])
    expect(broker.submitted.at(-1)).toMatchObject({
      order_class: "mleg",
      type: "market",
      legs: [
        { symbol: NVDA_CALL_140, side: "sell", position_intent: "sell_to_close" },
        { symbol: NVDA_CALL_150, side: "buy", position_intent: "buy_to_close" },
      ],
    })
    expect(broker.holdings.has(NVDA_CALL_140) || broker.holdings.has(NVDA_CALL_150)).toBe(false)
  })

  it("reopens a position whose exit didn't fill, so the next check retries", async () => {
    const doc = await openCall()
    broker.fillMode = "accept"
    broker.setOptionQuote(NVDA_CALL_140, { bid: 2.3, ask: 2.5 })
    const notes = await settle(monitorOptions(ctx, { marketOpen: true }))
    expect(notes[0]).toMatch(/exit order new \(not filled\); will retry/)
    expect((await db.col.optionPositions.findOne({ _id: doc._id }))!.status).toBe("open")
    expect(alerts).toContainEqual(expect.objectContaining({ level: "error", title: "Couldn't close NVDA options position" }))
  })

  it("closes positions the broker no longer holds, and reports ones it doesn't know", async () => {
    const gone = optionPositionDoc({ opened_at: afterOpen(-1_000) })
    await db.col.optionPositions.insertOne(gone)
    broker.setPosition(NVDA_PUT_130, 2, 4)
    const notes = await reconcileOptions(ctx, await broker.client.getPositions(), NOW)
    expect(notes).toEqual(["NVDA: position missing at the broker; marked closed"])
    expect(await db.col.optionPositions.findOne({ _id: gone._id })).toMatchObject({ status: "closed", exit_reason: "closed at the broker" })
    expect(alerts.map((a) => a.title)).toEqual(["NVDA options position closed outside the bot", "Untracked options positions"])
  })

  it("gives a fresh position time to show up at the broker", async () => {
    await db.col.optionPositions.insertOne(optionPositionDoc({ opened_at: new Date(NOW.getTime() - 60_000) }))
    expect(await reconcileOptions(ctx, [], NOW)).toEqual([])
  })
})
