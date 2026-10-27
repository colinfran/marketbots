import { createRequire } from "node:module"
import { COMMAND_LABEL, commandSchema } from "@mb/stock-core/commands"
import { CORE_ACTIONS, coreReviewSchema } from "@mb/stock-core/core-book"
import { COLLECTIONS, INDEXES } from "@mb/stock-core/db"
import { clientFrameSchema, EPHEMERAL_EVENTS, EVENT_SCHEMA_VERSION, eventEnvelopeSchema, OWNER_ONLY_EVENTS, STREAM_PROTOCOL_VERSION } from "@mb/stock-core/events"
import { FILLED_ORDERS } from "@mb/stock-core/fills"
import { OCC_PATTERN, OPTION_MULTIPLIER, OPTION_STRATEGIES, STRATEGY_LABEL } from "@mb/stock-core/options"
import { ACTIONS, botReportSchema, decisionSchema, HORIZONS, IMPACTS, OPTION_ACTIONS, optionOrderSchema, REGIMES, SENTIMENTS, SETUPS, SEVERITIES, STANCES, STOCK_ACTIONS } from "@mb/stock-core/report"
import { DEFAULT_SETTINGS, MODEL_ID_PATTERN, PHASES, settingsSchema, TICKER_PATTERN } from "@mb/stock-core/settings"
import { SETUP_INFO } from "@mb/stock-core/setups"
import { STREAM_TOKEN_TTL_SECONDS } from "@mb/stock-core/stream-token"
import { MARKET_TZ } from "@mb/stock-core/time"
import { CATEGORY_BASE, NOTABLE_REASONS, TIER_FACTOR, WIRE_KINDS } from "@mb/stock-core/wire"
import ts from "typescript"
import { describe, it } from "vitest"
import { z } from "zod"
import { matchJson } from "./snapshot"

/**
 * Settings, commands, database layout, event types and the AI output schema, as today's code
 * defines them. JSON Schemas come from zod's own converter (zod 4). Refinements (settingsSchema's
 * superRefine: ascending wire thresholds, stop bounds, loss limits, DTE and delta bands, premium
 * caps, unique benchmarks) have no JSON Schema form, so they are not in the schema files;
 * settings-validation.json covers them by recording which settings validate and how.
 *
 * Not covered: the lenient repair schema in src/ai/repair.ts (z.preprocess everywhere, and not
 * exported); its behavior is covered by repairReport's own tests.
 */

const jsonSchema = (schema: z.ZodType, io: "input" | "output") => z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" })

/** The defaults, each refinement broken once, and unknown keys: what the schema accepts or rejects, and how. */
const settingsValidation = () => {
  const S = DEFAULT_SETTINGS
  const cases: Record<string, unknown> = {
    defaults: S,
    "wire.thresholds not ascending": { ...S, wire: { ...S.wire, thresholds: { annotate: 30, review: 80, evaluate: 70, critical: 85 } } },
    "wire.summaries.pause_hours across midnight": { ...S, wire: { ...S.wire, summaries: { ...S.wire.summaries, pause_hours: ["22-6", "12-13"] } } },
    "wire.summaries.pause_hours range starts where it ends": { ...S, wire: { ...S.wire, summaries: { ...S.wire.summaries, pause_hours: ["6-6"] } } },
    "risk.min_stop_pct >= max_stop_pct": { ...S, risk: { ...S.risk, min_stop_pct: 2, max_stop_pct: 2 } },
    "risk.default_stop_pct outside the stop bounds": { ...S, risk: { ...S.risk, default_stop_pct: 9 } },
    "risk.max_daily_loss_pct >= flatten_loss_pct": { ...S, risk: { ...S.risk, max_daily_loss_pct: 4 } },
    "options.min_dte >= max_dte": { ...S, options: { ...S.options, min_dte: 45 } },
    "options.close_at_dte >= min_dte": { ...S, options: { ...S.options, close_at_dte: 14 } },
    "options.min_delta >= max_delta": { ...S, options: { ...S.options, min_delta: 0.7 } },
    "options.max_premium_per_trade_pct > max_total_premium_pct": { ...S, options: { ...S.options, max_premium_per_trade_pct: 16 } },
    "duplicate benchmarks": { ...S, universe: { ...S.universe, benchmarks: ["SPY", "SPY"] } },
    "core.min_holdings > max_holdings": { ...S, core: { ...S.core, min_holdings: 9 } },
    "core.target_pct + risk.cash_reserve_pct > 100": { ...S, core: { ...S.core, target_pct: 90 }, risk: { ...S.risk, cash_reserve_pct: 15 } },
    "core.review_time_et outside the session": { ...S, core: { ...S.core, review_time_et: "15:45" } },
    "core.themes malformed": { ...S, core: { ...S.core, themes: ["AI buildout: NVDA, AVGO", "Chips: 2330"] } },
    "unknown keys are dropped": { ...S, extra: 1, risk: { ...S.risk, extra: 2 } },
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
  it("command JSON Schema and labels", () => {
    matchJson("commands.schema.json", { command: jsonSchema(commandSchema, "input"), labels: COMMAND_LABEL })
  })
})

describe("contracts: database", () => {
  it("collection names and indexes", () => {
    matchJson("db.json", { collections: COLLECTIONS, indexes: INDEXES, filled_orders_filter: FILLED_ORDERS })
  })
})

describe("contracts: events and stream", () => {
  it("event types, visibility sets and stream schemas", () => {
    matchJson("events.json", {
      event_schema_version: EVENT_SCHEMA_VERSION,
      stream_protocol_version: STREAM_PROTOCOL_VERSION,
      stream_token_ttl_seconds: STREAM_TOKEN_TTL_SECONDS,
      event_types: typeKeys("@mb/stock-core/events", "EventDataMap"),
      owner_only: OWNER_ONLY_EVENTS,
      ephemeral: EPHEMERAL_EVENTS,
      envelope_schema: jsonSchema(eventEnvelopeSchema, "input"),
      client_frame_schema: jsonSchema(clientFrameSchema, "input"),
    })
  })
})

describe("contracts: domain constants", () => {
  it("phases, patterns, options, setups and wire categories", () => {
    matchJson("constants.json", {
      phases: PHASES,
      market_tz: MARKET_TZ,
      patterns: { model_id: MODEL_ID_PATTERN, ticker: TICKER_PATTERN, occ: OCC_PATTERN },
      option_multiplier: OPTION_MULTIPLIER,
      option_strategies: OPTION_STRATEGIES,
      option_strategy_labels: STRATEGY_LABEL,
      setups: SETUP_INFO,
      wire_kinds: WIRE_KINDS,
      category_base: CATEGORY_BASE,
      tier_factor: TIER_FACTOR,
      notable_reasons: NOTABLE_REASONS,
    })
  })
})

describe("contracts: AI output schema", () => {
  it("bot report, decision, option order and the core review", () => {
    matchJson("ai.schema.json", {
      enums: { sentiments: SENTIMENTS, regimes: REGIMES, stances: STANCES, stock_actions: STOCK_ACTIONS, option_actions: OPTION_ACTIONS, actions: ACTIONS, horizons: HORIZONS, setups: SETUPS, impacts: IMPACTS, severities: SEVERITIES, core_actions: CORE_ACTIONS },
      bot_report: jsonSchema(botReportSchema, "input"),
      decision: jsonSchema(decisionSchema, "input"),
      option_order: jsonSchema(optionOrderSchema, "input"),
      core_review: jsonSchema(coreReviewSchema, "input"),
    })
  })
})
