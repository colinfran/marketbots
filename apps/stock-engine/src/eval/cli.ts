/**
 * The local-model eval for stock (docs/plans/LOCAL-AI.md §10, §14 step 0). Read-only against
 * Atlas; never run by the engine (esbuild bundles only src/main.ts).
 *
 *   pnpm --filter @mb/stock-engine eval export [--limit 200]
 *   pnpm --filter @mb/stock-engine eval run --url http://127.0.0.1:18080 --model gpt-oss-20b --family gpt-oss --thinking medium [--limit 40]
 *   pnpm --filter @mb/stock-engine eval summary
 *
 * `export` rebuilds each recorded report's decision prompt with today's prompt code from the
 * context Grok saw (reports keep it whole), the research memo, and the wire dossier as of the
 * cycle's start. Stock decisions aren't one per listed symbol, so agreement with Grok is counted
 * on what was bought and sold.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { WireTriggerDoc } from "@mb/core/wire"
import { complete, percentile, type EvalModel, type ModelFamily, type ThinkingLevel } from "@mb/engine-kit/ai/eval"
import type { CycleDoc, ReportDoc } from "@mb/stock-core/db"
import { botReportSchema, normalizeReport } from "@mb/stock-core/report"
import { settingsSchema, type Settings } from "@mb/stock-core/settings"
import { formatTime } from "@mb/stock-core/time"
import type { WireItemDoc } from "@mb/stock-core/wire"
import { MongoClient } from "mongodb"
import { z } from "zod"
import { decisionPrompt, decisionSystemPrompt, eventSection } from "../ai/prompts"
import { repairReport } from "../ai/repair"
import { assembleDossier } from "../wire/dossier"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const DIR = join(ROOT, "data", "eval")
const SET = join(DIR, "stock.jsonl")
const HOUR = 3_600_000

type Recorded = { symbol: string; action: string }
type SetItem = { id: string; at: string; kind: string; phase: string; system: string; prompt: string; allow: boolean; grok: Recorded[] }

const args = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)

const exportSet = async () => {
  const client = new MongoClient(process.env.MONGODB_URI ?? "")
  await client.connect()
  try {
    const db = client.db(process.env.MONGODB_DB_NAME)
    const settingsDoc = await db.collection<{ _id: string; settings: unknown }>("settings").findOne({ _id: "current" })
    const settings: Settings = settingsSchema.parse(settingsDoc?.settings)
    const reports = await db
      .collection<ReportDoc>("reports")
      .find({})
      .sort({ created_at: -1 })
      .limit(Number(flag("limit", "200")))
      .toArray()
    const items: SetItem[] = []
    for (const r of reports.reverse()) {
      const cycle = await db.collection<CycleDoc>("cycles").findOne({ _id: r.cycle_id })
      const start = cycle?.started_at ?? r.created_at
      const ctx = r.context
      const subjects = [...new Set([...ctx.positions.map((p) => p.symbol), ...ctx.options.positions.map((p) => p.underlying), ...ctx.instruments.map((i) => i.symbol)])]
      const wireItems = await db
        .collection<WireItemDoc>("wire_items")
        .find({ first_seen_at: { $gte: new Date(start.getTime() - 24 * HOUR), $lt: start }, $or: [{ symbols: { $in: subjects } }, { symbols: { $size: 0 } }] })
        .sort({ severity: -1, first_seen_at: -1 })
        .limit(600)
        .toArray()
      const usedWire = r.research.dossier !== undefined
      const dossier = usedWire ? assembleDossier(wireItems, { symbols: subjects, since: new Date(start.getTime() - 24 * HOUR), now: start, price: () => null, timeLabel: formatTime, reviewThreshold: settings.wire.thresholds.review }) : null
      let event: string | undefined
      if (cycle?.kind === "event" && cycle.wire_trigger_id) {
        const trigger = await db.collection<WireTriggerDoc>("wire_triggers").findOne({ _id: cycle.wire_trigger_id })
        const first = trigger ? await db.collection<WireItemDoc>("wire_items").findOne({ _id: trigger.item_ids[0] }) : null
        if (trigger) event = eventSection([{ rule: trigger.rule, headline: first?.title ?? trigger.reason, severity: trigger.severity, symbol: trigger.symbols[0] ?? null }])
      }
      items.push({
        id: r._id,
        at: start.toISOString(),
        kind: cycle?.kind ?? "scheduled",
        phase: r.phase,
        system: decisionSystemPrompt(settings),
        prompt: decisionPrompt(r.phase, ctx, r.research, settings, { wire: dossier ? dossier.text : undefined, event, researchSkipped: cycle?.research_skip_reason ?? null }),
        allow: r.phase === "intraday" || r.phase === "close",
        grok: r.report.decisions.map((d) => ({ symbol: d.symbol, action: d.action })),
      })
    }
    mkdirSync(DIR, { recursive: true })
    writeFileSync(SET, items.map((i) => JSON.stringify(i)).join("\n") + "\n")
    console.log(`exported ${items.length} reports to ${SET}`)
  } finally {
    await client.close()
  }
}

const SCHEMA = z.toJSONSchema(botReportSchema) as Record<string, unknown>

const modelOf = (): EvalModel => ({
  url: flag("url", "http://127.0.0.1:18080")!,
  name: flag("model", "local")!,
  family: flag("family", "other") as ModelFamily,
  thinking: flag("thinking", "medium") as ThinkingLevel,
})

const TRADES = new Set(["buy", "sell", "buy_option", "close_option"])
const tradeKeys = (ds: Recorded[]) => new Set(ds.filter((d) => TRADES.has(d.action)).map((d) => `${d.action} ${d.symbol}`))

/** Valid in the schema, and how the trades (buys and sells) compare with Grok's. */
const score = (item: SetItem, content: string, json: unknown) => {
  const strict = botReportSchema.safeParse(json)
  const repaired = strict.success ? null : repairReport(content)
  const report = strict.success ? strict.data : repaired?.report
  const grok = tradeKeys(item.grok)
  if (!report) return { valid: false, repaired: false, trades: 0, grok_trades: grok.size, shared_trades: 0, both_flat: false }
  const mine = tradeKeys(normalizeReport(report, { allowDecisions: item.allow }).decisions)
  return { valid: strict.success, repaired: !strict.success, trades: mine.size, grok_trades: grok.size, shared_trades: [...mine].filter((k) => grok.has(k)).length, both_flat: mine.size === 0 && grok.size === 0 }
}

const run = async () => {
  const model = modelOf()
  const items = readJsonl<SetItem>(SET).slice(-Number(flag("limit", "1000")))
  const out = join(DIR, "results", `stock-decision-${model.name}-${model.thinking}${flag("tag") ? `-${flag("tag")}` : ""}.jsonl`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, "")
  for (const [n, item] of items.entries()) {
    const call = await complete(model, [{ role: "system", content: item.system }, { role: "user", content: item.prompt }], SCHEMA, { temperature: 0.3 })
    const s = call.ok ? score(item, call.content, call.json) : null
    const row = { id: item.id, kind: item.kind, phase: item.phase, ...s, error: call.error, wall_ms: call.wall_ms, prompt_tokens: call.prompt_tokens, completion_tokens: call.completion_tokens, reasoning_chars: call.reasoning.length, prompt_per_s: call.prompt_per_s, gen_per_s: call.gen_per_s, finish: call.finish_reason, content: call.content, reasoning: call.reasoning.slice(0, 4000) }
    writeFileSync(out, JSON.stringify(row) + "\n", { flag: "a" })
    console.log(`${n + 1}/${items.length} ${item.phase} ${call.ok ? (s?.valid ? "valid" : s?.repaired ? "repaired" : "INVALID") : `ERROR ${call.error}`} ${(call.wall_ms / 1000).toFixed(1)}s in=${call.prompt_tokens} out=${call.completion_tokens} think=${call.reasoning.length}ch gen=${call.gen_per_s.toFixed(1)}t/s pp=${call.prompt_per_s.toFixed(0)}t/s trades=${s?.trades ?? 0} grok=${s?.grok_trades ?? 0} shared=${s?.shared_trades ?? 0}`)
  }
  console.log(`results in ${out}`)
}

const summary = () => {
  const dir = join(DIR, "results")
  for (const f of readdirSync(dir).filter((x) => x.startsWith("stock-")).sort()) {
    const rows = readJsonl<Record<string, number | boolean | string | null>>(join(dir, f))
    const secs = rows.map((r) => Number(r.wall_ms) / 1000)
    const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
    console.log(
      `${f}: n=${rows.length} valid=${rows.filter((r) => r.valid).length} repaired=${rows.filter((r) => r.repaired).length} trades=${sum("trades")} grok_trades=${sum("grok_trades")} shared=${sum("shared_trades")} both_flat=${rows.filter((r) => r.both_flat).length} p50=${percentile(secs, 50).toFixed(1)}s p95=${percentile(secs, 95).toFixed(1)}s gen=${percentile(rows.map((r) => Number(r.gen_per_s)), 50).toFixed(1)}t/s pp=${percentile(rows.map((r) => Number(r.prompt_per_s)), 50).toFixed(0)}t/s think=${percentile(rows.map((r) => Number(r.reasoning_chars)), 50)}ch`,
    )
  }
}

const command = args[0]
if (command === "export") await exportSet()
else if (command === "run") await run()
else if (command === "summary") summary()
else console.log("usage: eval export|run|summary (see src/eval/cli.ts)")
