import { createRequire } from "node:module"
import { backtestParamsSchema, BACKTEST_INTERVALS, BACKTEST_STRATEGIES, COMMAND_LABEL, commandSchema } from "@mb/crypto-core/commands"
import { COLLECTIONS, INDEXES, TERMINAL_ORDER_STATUSES } from "@mb/crypto-core/db"
import { clientFrameSchema, EPHEMERAL_EVENTS, EVENT_SCHEMA_VERSION, eventEnvelopeSchema, OWNER_ONLY_EVENTS, STREAM_PROTOCOL_VERSION } from "@mb/crypto-core/events"
import { CRYPTO_ACTIONS, cryptoReportSchema, EVIDENCE_KINDS, MAX_HORIZON_HOURS, PRICED_IN, REGIMES, SEED_MAX_ALLOCATIONS, SEED_MIN_HORIZON_HOURS, seedAllocationSchema, UNCERTAINTY } from "@mb/crypto-core/report"
import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import { STRATEGIES, STRATEGY_IDS } from "@mb/crypto-core/strategies"
import { CATEGORY_BASE, NOTABLE_REASONS, TIER_FACTOR, WIRE_KINDS } from "@mb/crypto-core/wire"
import ts from "typescript"
import { describe, it } from "vitest"
import { z } from "zod"
import { matchJson } from "./snapshot"

/**
 * Settings, commands, database layout, event types and the AI output schemas, as today's code
 * defines them. JSON Schemas come from zod's own converter (zod 4). Refinements (settingsSchema's
 * superRefine: ascending wire thresholds, min_stop < max_stop, position ≤ asset exposure, unique
 * symbols) have no JSON Schema form, so they are not in the schema files; the settings test
 * covers them by checking which patches validate.
 */

const jsonSchema = (schema: z.ZodType, io: "input" | "output") => z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" })

/** The defaults, each refinement broken once, and unknown keys: what the schema accepts or rejects, and how. */
const settingsValidation = () => {
  const cases: Record<string, unknown> = {
    defaults: DEFAULT_SETTINGS,
    "wire.thresholds not ascending": { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, thresholds: { annotate: 30, review: 80, evaluate: 70, critical: 85 } } },
    "kraken.min_stop_pct >= max_stop_pct": { ...DEFAULT_SETTINGS, kraken: { ...DEFAULT_SETTINGS.kraken, min_stop_pct: 12, max_stop_pct: 12 } },
    "kraken.max_position_pct > max_asset_exposure_pct": { ...DEFAULT_SETTINGS, kraken: { ...DEFAULT_SETTINGS.kraken, max_position_pct: 31 } },
    "duplicate universe symbols": { ...DEFAULT_SETTINGS, universe: { kraken_symbols: ["BTC/USD", "BTC/USD"] } },
    "unknown keys are dropped": { ...DEFAULT_SETTINGS, extra: 1, kraken: { ...DEFAULT_SETTINGS.kraken, extra: 2 } },
  }
  return Object.fromEntries(
    Object.entries(cases).map(([name, value]) => {
      const r = settingsSchema.safeParse(value)
      return [name, r.success ? { ok: true, equals_input: JSON.stringify(r.data) === JSON.stringify(value) } : { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })) }]
    }),
  )
}

/** The keys of a type alias (an object type), read with the TypeScript checker from the module that exports it. */
const typeKeys = (specifier: string, typeName: string) => {
  const file = createRequire(import.meta.url).resolve(specifier)
  const program = ts.createProgram([file], { noEmit: true, noLib: true, types: [], skipLibCheck: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)!
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)
  let symbol = exported.find((s) => s.getName() === typeName)
  if (!symbol) throw new Error(`${specifier} exports no ${typeName}`)
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const type = checker.getDeclaredTypeOfSymbol(symbol)
  return checker.getPropertiesOfType(type).map((p) => {
    const data = checker.getTypeOfSymbol(p)
    const keys = data.isUnion() ? null : checker.getPropertiesOfType(data).map((k) => `${k.getName()}${k.flags & ts.SymbolFlags.Optional ? "?" : ""}`)
    return { type: p.getName(), data_keys: keys }
  })
}

describe("contracts: settings", () => {
  it("DEFAULT_SETTINGS", () => matchJson("default-settings.json", DEFAULT_SETTINGS))

  it("settings JSON Schema (input and output)", () => {
    matchJson("settings.schema.json", { input: jsonSchema(settingsSchema, "input"), output: jsonSchema(settingsSchema, "output") })
  })

  it("settings refinements", () => matchJson("settings-validation.json", settingsValidation()))
})

describe("contracts: commands", () => {
  it("command JSON Schema, labels and backtest options", () => {
    matchJson("commands.schema.json", {
      command: jsonSchema(commandSchema, "input"),
      backtest_params: jsonSchema(backtestParamsSchema, "input"),
      labels: COMMAND_LABEL,
      backtest_intervals: BACKTEST_INTERVALS,
      backtest_strategies: BACKTEST_STRATEGIES,
    })
  })
})

describe("contracts: database", () => {
  it("collection names and indexes", () => {
    matchJson("db.json", { collections: COLLECTIONS, indexes: INDEXES, terminal_order_statuses: TERMINAL_ORDER_STATUSES })
  })
})

describe("contracts: events and stream", () => {
  it("event types, visibility sets and stream schemas", () => {
    matchJson("events.json", {
      event_schema_version: EVENT_SCHEMA_VERSION,
      stream_protocol_version: STREAM_PROTOCOL_VERSION,
      event_types: typeKeys("@mb/crypto-core/events", "EventDataMap"),
      owner_only: OWNER_ONLY_EVENTS,
      ephemeral: EPHEMERAL_EVENTS,
      envelope_schema: jsonSchema(eventEnvelopeSchema, "input"),
      client_frame_schema: jsonSchema(clientFrameSchema, "input"),
    })
  })
})

describe("contracts: domain constants", () => {
  it("strategies and wire categories", () => {
    matchJson("constants.json", { strategy_ids: STRATEGY_IDS, strategies: STRATEGIES, wire_kinds: WIRE_KINDS, category_base: CATEGORY_BASE, tier_factor: TIER_FACTOR, notable_reasons: NOTABLE_REASONS })
  })
})

describe("contracts: AI output schemas", () => {
  it("decision report and seed allocation", () => {
    matchJson("ai.schema.json", {
      enums: { evidence_kinds: EVIDENCE_KINDS, uncertainty: UNCERTAINTY, priced_in: PRICED_IN, regimes: REGIMES, actions: CRYPTO_ACTIONS },
      limits: { max_horizon_hours: MAX_HORIZON_HOURS, seed_max_allocations: SEED_MAX_ALLOCATIONS, seed_min_horizon_hours: SEED_MIN_HORIZON_HOURS },
      crypto_report: jsonSchema(cryptoReportSchema, "input"),
      seed_allocation: jsonSchema(seedAllocationSchema, "input"),
    })
  })
})
