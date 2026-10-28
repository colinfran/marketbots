/**
 * The local-model eval for crypto (docs/plans/LOCAL-AI.md §10, §14 step 0). Read-only against
 * Atlas; never run by the engine (esbuild bundles only src/main.ts).
 *
 *   pnpm --filter @mb/crypto-engine eval export [--limit 200]
 *   pnpm --filter @mb/crypto-engine eval run --url http://127.0.0.1:18080 --model gpt-oss-20b --family gpt-oss --thinking medium [--limit 40]
 *   pnpm --filter @mb/crypto-engine eval episode --url ... --model ... --family ... --thinking low [--limit 5]
 *   pnpm --filter @mb/crypto-engine eval summary
 *
 * `export` rebuilds each recorded decision cycle's prompt with today's prompt code, from what the
 * cycle stored: the candidates with their features and hints, the held positions, the research
 * memo, and the wire dossier as of the cycle's start. The rebuild is close, not exact (held
 * positions' features and the account line aren't stored), which is enough to judge a model's
 * reliability and speed and to compare its actions with Grok's. It says nothing about edge.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CycleDoc, DecisionDoc, PositionDoc, ResearchDoc, RegimeSnapshot } from "@mb/crypto-core/db"
import { cryptoReportSchema, normalizeCryptoReport } from "@mb/crypto-core/report"
import { settingsSchema, type Settings } from "@mb/crypto-core/settings"
import type { WireItemDoc } from "@mb/crypto-core/wire"
import type { WireTriggerDoc } from "@mb/core/wire"
import { complete, percentile, runEpisode, type EvalModel, type ModelFamily, type ThinkingLevel } from "@mb/engine-kit/ai/eval"
import { MongoClient } from "mongodb"
import { z } from "zod"
import { repairCryptoReport } from "../ai/repair"
import { cryptoDecisionPrompt, cryptoDecisionSystemPrompt, eventSection } from "../ai/prompts"
import { assembleDossier } from "../wire/dossier"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const DIR = join(ROOT, "data", "eval")
const SET = join(DIR, "crypto.jsonl")
const HOUR = 3_600_000

type Recorded = { symbol: string; action: string; conviction: number; p_target_first: number | null }
type SetItem = { id: string; at: string; kind: string; system: string; prompt: string; candidates: string[]; held: string[]; urls: string[]; grok: Recorded[] }

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

const utcTime = (d: Date) => `${d.toISOString().slice(11, 16)}Z`
const roundTo = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d

const exportSet = async () => {
  const client = new MongoClient(process.env.MONGODB_URI ?? "")
  await client.connect()
  try {
    const db = client.db(process.env.MONGODB_DB_NAME)
    const settingsDoc = await db.collection<{ _id: string; settings: unknown }>("settings").findOne({ _id: "current" })
    const settings: Settings = settingsSchema.parse(settingsDoc?.settings)
    const cycles = await db
      .collection<CycleDoc>("cycles")
      .find({ "decision_ids.0": { $exists: true }, kind: { $ne: "seed" } })
      .sort({ started_at: -1 })
      .limit(Number(flag("limit", "200")))
      .toArray()
    const items: SetItem[] = []
    for (const c of cycles.reverse()) {
      const start = c.started_at
      const decisions = await db.collection<DecisionDoc>("decisions").find({ _id: { $in: c.decision_ids } }).toArray()
      const research = c.research_id ? await db.collection<ResearchDoc>("research").findOne({ _id: c.research_id }) : null
      const priceOf = new Map(decisions.map((d) => [d.symbol, d.quant.price]))
      const candidates = c.candidates.map(({ instrument, strategy, score, signal, features }) => {
        const { stop_hint, target_hint, ...rest } = features
        return { symbol: instrument, strategy, score, signal, stop_hint, target_hint, est_round_trip_cost_bps: decisions.find((d) => d.symbol === instrument)?.costs.round_trip_bps ?? null, features: rest }
      })
      const positions = (
        await Promise.all(c.reviews.map((symbol) => db.collection<PositionDoc>("positions").findOne({ symbol, opened_at: { $lte: start } }, { sort: { opened_at: -1 } })))
      ).flatMap((p) => (p ? [p] : []))
      const open = await db.collection<PositionDoc>("positions").countDocuments({ opened_at: { $lte: start }, $or: [{ closed_at: null }, { closed_at: { $gt: start } }] })
      const recent = await db
        .collection<DecisionDoc>("decisions")
        .find({ symbol: { $in: [...candidates.map((x) => x.symbol), ...c.reviews] }, created_at: { $gte: new Date(start.getTime() - 48 * HOUR), $lt: start } })
        .sort({ created_at: -1 })
        .limit(15)
        .toArray()
      const closed = await db
        .collection<PositionDoc>("positions")
        .find({ status: "closed", closed_at: { $lt: start }, exit_reason: { $nin: ["paper_reset", "reconciliation"] } })
        .toArray()
      const byStrategy = new Map<string, { trades: number; wins: number; pnl: number }>()
      for (const p of closed) {
        if (!p.strategy_id) continue
        const s = byStrategy.get(p.strategy_id) ?? { trades: 0, wins: 0, pnl: 0 }
        s.trades += 1
        s.wins += p.realized_pnl_usd > 0 ? 1 : 0
        s.pnl += p.realized_pnl_usd
        byStrategy.set(p.strategy_id, s)
      }
      const subjects = [...candidates.map((x) => x.symbol), ...c.reviews]
      const wireItems = await db
        .collection<WireItemDoc>("wire_items")
        .find({ first_seen_at: { $gte: new Date(start.getTime() - 72 * HOUR), $lt: start }, $or: [{ symbols: { $in: subjects } }, { symbols: { $size: 0 } }] })
        .sort({ severity: -1, first_seen_at: -1 })
        .limit(600)
        .toArray()
      const dossier = settings.wire.mode !== "off" ? assembleDossier(wireItems, { symbols: subjects, since: new Date(start.getTime() - 72 * HOUR), now: start, price: (s) => priceOf.get(s) ?? null, timeLabel: utcTime, reviewThreshold: settings.wire.thresholds.review }) : null
      let event: string | undefined
      if (c.kind === "event" && c.wire_trigger_id) {
        const trigger = await db.collection<WireTriggerDoc>("wire_triggers").findOne({ _id: c.wire_trigger_id })
        const first = trigger ? await db.collection<WireItemDoc>("wire_items").findOne({ _id: trigger.item_ids[0] }) : null
        if (trigger) event = eventSection([{ rule: trigger.rule, headline: first?.title ?? trigger.reason, severity: trigger.severity, symbol: trigger.symbols[0] ?? null }])
      }
      const regime = c.regime ?? ({ label: "unknown", btc_trend: null, btc_vol_pct: null, breadth_pct: null, notes: [] } as unknown as RegimeSnapshot)
      const prompt = cryptoDecisionPrompt({
        now: start,
        regime,
        account: { mode: "paper", open_positions: open, new_entries_allowed: candidates.length > 0 },
        limits: {
          max_position_pct: settings.kraken.max_position_pct,
          risk_per_trade_pct: settings.kraken.risk_per_trade_pct,
          min_reward_risk: settings.kraken.min_reward_risk,
          min_edge_bps_after_costs: settings.kraken.min_edge_bps,
          min_conviction: settings.kraken.min_conviction,
          stop_range_pct: [settings.kraken.min_stop_pct, settings.kraken.max_stop_pct],
          fee_bps_per_side: decisions[0]?.costs.fee_bps ?? null,
        },
        candidates,
        positions: positions.map((p) => {
          const mark = priceOf.get(p.symbol) ?? p.mark_price ?? p.avg_price
          return {
            symbol: p.symbol,
            review_reason: "scheduled review",
            entry_price: p.avg_price,
            price: mark,
            pnl_pct: roundTo((mark / p.avg_price - 1) * 100, 2),
            stop: p.stop_price,
            target: p.take_profit_price,
            age_hours: roundTo((start.getTime() - p.opened_at.getTime()) / HOUR, 1),
            strategy: p.strategy_id,
            thesis: p.thesis,
            invalidation: p.invalidation,
            features: null,
          }
        }),
        recent: recent.map((d) => ({ symbol: d.symbol, at: d.created_at.toISOString().slice(0, 16), action: d.action, conviction: d.ai.conviction, execution: d.execution.status })),
        trackRecord: [...byStrategy].map(([strategy, s]) => ({ strategy, closed_trades: s.trades, win_rate_pct: Math.round((s.wins / s.trades) * 100), net_pnl_sign: Math.sign(s.pnl) })),
        memo: research?.memo ?? "",
        researchError: research?.error ?? null,
        wire: dossier?.text,
        event,
        researchSkipped: c.research_skip_reason ?? null,
      })
      items.push({
        id: c._id,
        at: start.toISOString(),
        kind: c.kind ?? "scheduled",
        system: cryptoDecisionSystemPrompt(),
        prompt,
        candidates: candidates.map((x) => x.symbol),
        held: positions.map((p) => p.symbol),
        urls: [...(research?.sources.map((s) => s.url) ?? []), ...(dossier?.urls ?? [])],
        grok: decisions.map((d) => ({ symbol: d.symbol, action: d.action, conviction: d.ai.conviction, p_target_first: d.ai.p_target_first })),
      })
    }
    mkdirSync(DIR, { recursive: true })
    writeFileSync(SET, items.map((i) => JSON.stringify(i)).join("\n") + "\n")
    console.log(`exported ${items.length} cycles to ${SET}`)
  } finally {
    await client.close()
  }
}

const SCHEMA = z.toJSONSchema(cryptoReportSchema) as Record<string, unknown>

const modelOf = (): EvalModel => ({
  url: flag("url", "http://127.0.0.1:18080")!,
  name: flag("model", "local")!,
  family: flag("family", "other") as ModelFamily,
  thinking: flag("thinking", "medium") as ThinkingLevel,
})

/** Valid in the schema, every listed symbol decided, and how many actions match Grok's. */
const score = (item: SetItem, content: string, json: unknown) => {
  const strict = cryptoReportSchema.safeParse(json)
  const repaired = strict.success ? null : repairCryptoReport(content)
  const report = strict.success ? strict.data : repaired?.report
  if (!report) return { valid: false, repaired: false, covered: false, agree: 0, entry_agree: 0, compared: 0, buys: 0, grok_buys: item.grok.filter((g) => g.action === "buy").length }
  const normalized = normalizeCryptoReport(report, { candidates: new Set(item.candidates), held: new Set(item.held), sourceUrls: new Set(item.urls) })
  const bySymbol = new Map(normalized.decisions.map((d) => [d.symbol, d]))
  const compared = item.grok.filter((g) => bySymbol.has(g.symbol))
  return {
    valid: strict.success,
    repaired: !strict.success,
    covered: normalized.decisions.every((d) => !d.defaulted) && [...item.candidates, ...item.held].every((s) => bySymbol.has(s)),
    agree: compared.filter((g) => bySymbol.get(g.symbol)!.action === g.action).length,
    entry_agree: compared.filter((g) => (bySymbol.get(g.symbol)!.action === "buy") === (g.action === "buy")).length,
    compared: compared.length,
    buys: normalized.decisions.filter((d) => d.action === "buy").length,
    grok_buys: item.grok.filter((g) => g.action === "buy").length,
  }
}

const resultFile = (m: EvalModel, kind: string) => join(DIR, "results", `crypto-${kind}-${m.name}-${m.thinking}${flag("tag") ? `-${flag("tag")}` : ""}.jsonl`)

const run = async () => {
  const model = modelOf()
  const items = readJsonl<SetItem>(SET).slice(-Number(flag("limit", "1000")))
  const out = resultFile(model, "decision")
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, "")
  for (const [n, item] of items.entries()) {
    const call = await complete(model, [{ role: "system", content: item.system }, { role: "user", content: item.prompt }], SCHEMA, { temperature: 0.3 })
    const s = call.ok ? score(item, call.content, call.json) : null
    const row = { id: item.id, kind: item.kind, ...s, error: call.error, wall_ms: call.wall_ms, prompt_tokens: call.prompt_tokens, completion_tokens: call.completion_tokens, reasoning_chars: call.reasoning.length, prompt_per_s: call.prompt_per_s, gen_per_s: call.gen_per_s, finish: call.finish_reason, content: call.content, reasoning: call.reasoning.slice(0, 4000) }
    writeFileSync(out, JSON.stringify(row) + "\n", { flag: "a" })
    console.log(`${n + 1}/${items.length} ${item.id.slice(0, 8)} ${call.ok ? (s?.valid ? "valid" : s?.repaired ? "repaired" : "INVALID") : `ERROR ${call.error}`} ${(call.wall_ms / 1000).toFixed(1)}s in=${call.prompt_tokens} out=${call.completion_tokens} think=${call.reasoning.length}ch gen=${call.gen_per_s.toFixed(1)}t/s pp=${call.prompt_per_s.toFixed(0)}t/s agree=${s?.agree ?? 0}/${s?.compared ?? 0}`)
  }
  console.log(`results in ${out}`)
}

/** Canned tool results sized like §8.3's capped outputs (a few hundred tokens each). */
const TOOLS = [
  { name: "bars_summary", description: "bars_summary(symbol, interval, lookback): return, range, trend, volatility and notable days for a period", result: () => JSON.stringify({ return_pct: 4.2, range: [61200, 66850], trend: "up, higher lows since the 21st", realized_vol_pct: 38, notable: [{ day: "2026-10-23", move_pct: -3.9, note: "largest down day, volume 2.1x median" }, { day: "2026-10-26", move_pct: 2.7, note: "broke the 10-day high" }], vs_btc: "beta 1.3, correlation 0.82" }) },
  { name: "event_study", description: "event_study(subject, condition, horizons): forward returns after past occurrences of a condition, against random days", result: () => JSON.stringify({ condition: "24h return > +5% with volume > 2x median", occurrences: 37, since: "2019-03-01", forward: { "1d": { median_pct: 0.4, q1: -2.1, q3: 2.9, hit_rate: 0.54 }, "3d": { median_pct: 0.9, q1: -3.8, q3: 5.1, hit_rate: 0.57 }, "7d": { median_pct: 1.6, q1: -5.9, q3: 8.4, hit_rate: 0.59 } }, baseline_random_days: { "1d": { median_pct: 0.1, hit_rate: 0.51 }, "3d": { median_pct: 0.3, hit_rate: 0.52 }, "7d": { median_pct: 0.7, hit_rate: 0.53 } } }) },
  { name: "past_decisions", description: "past_decisions(symbol): the bot's own decisions on it, with outcomes", result: () => JSON.stringify([{ at: "2026-10-26T14:00Z", action: "no_trade", conviction: 35, outcome_24h_pct: 1.8 }, { at: "2026-10-25T09:00Z", action: "buy", conviction: 62, outcome: "stopped out, -1.1R" }]) },
  { name: "news", description: "news(subject, since): the wire's items on a subject", result: () => JSON.stringify([{ at: "13:02Z", tier: 2, source: "coindesk.com", title: "Spot ETF inflows top $400M for a third day", severity: 48 }, { at: "11:40Z", tier: 3, source: "x.com", title: "Whale wallet moves 12,000 coins to an exchange", severity: 31 }]) },
  { name: "forecast", description: "forecast(symbol, setup): calibrated probability the target hits before the stop, with its test record", result: () => JSON.stringify({ p_target_first: 0.41, prior: 0.33, brier: 0.214, brier_prior: 0.221, test_period: "2024-01-01..2026-09-30", n_test: 412 }) },
]

const episode = async () => {
  const model = modelOf()
  const items = readJsonl<SetItem>(SET)
    .filter((i) => i.candidates.length > 0)
    .slice(-Number(flag("limit", "5")))
  const out = resultFile(model, "episode")
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, "")
  for (const [n, item] of items.entries()) {
    const r = await runEpisode(model, { system: item.system, brief: item.prompt, tools: TOOLS, answerSchema: SCHEMA, maxTools: 5 })
    const final = r.steps.at(-1)
    const s = r.answered ? score(item, JSON.stringify(r.answer), r.answer) : null
    const row = {
      id: item.id,
      answered: r.answered,
      valid: s?.valid ?? false,
      wall_ms: r.wall_ms,
      tools: r.steps.filter((x) => x.kind === "tool").map((x) => `${x.tool}: ${x.purpose}`),
      steps: r.steps.map((x) => ({ kind: x.kind, wall_ms: x.call.wall_ms, prompt_tokens: x.call.prompt_tokens, cached: x.call.cached_tokens, out: x.call.completion_tokens, think_chars: x.call.reasoning.length, pp: x.call.prompt_per_s, gen: x.call.gen_per_s, error: x.call.error })),
      error: final?.call.error ?? null,
    }
    writeFileSync(out, JSON.stringify(row) + "\n", { flag: "a" })
    console.log(`${n + 1}/${items.length} ${item.id.slice(0, 8)} ${r.answered ? "answered" : "NO ANSWER"} ${(r.wall_ms / 1000).toFixed(1)}s steps=${r.steps.length} ${row.tools.join(" | ")}`)
  }
  console.log(`results in ${out}`)
}

const summary = () => {
  const dir = join(DIR, "results")
  for (const f of readdirSync(dir).filter((x) => x.startsWith("crypto-")).sort()) {
    const rows = readJsonl<Record<string, number | boolean | string | null>>(join(dir, f))
    const secs = rows.map((r) => Number(r.wall_ms) / 1000)
    if (f.startsWith("crypto-decision")) {
      const compared = rows.reduce((s, r) => s + Number(r.compared ?? 0), 0)
      console.log(
        `${f}: n=${rows.length} valid=${rows.filter((r) => r.valid).length} repaired=${rows.filter((r) => r.repaired).length} covered=${rows.filter((r) => r.covered).length} agree=${rows.reduce((s, r) => s + Number(r.agree ?? 0), 0)}/${compared} entry_agree=${rows.reduce((s, r) => s + Number(r.entry_agree ?? 0), 0)}/${compared} buys=${rows.reduce((s, r) => s + Number(r.buys ?? 0), 0)} grok_buys=${rows.reduce((s, r) => s + Number(r.grok_buys ?? 0), 0)} p50=${percentile(secs, 50).toFixed(1)}s p95=${percentile(secs, 95).toFixed(1)}s gen=${percentile(rows.map((r) => Number(r.gen_per_s)), 50).toFixed(1)}t/s pp=${percentile(rows.map((r) => Number(r.prompt_per_s)), 50).toFixed(0)}t/s think=${percentile(rows.map((r) => Number(r.reasoning_chars)), 50)}ch`,
      )
    } else {
      console.log(`${f}: n=${rows.length} answered=${rows.filter((r) => r.answered).length} valid=${rows.filter((r) => r.valid).length} p50=${percentile(secs, 50).toFixed(1)}s p95=${percentile(secs, 95).toFixed(1)}s`)
    }
  }
}

const command = args[0]
if (command === "export") await exportSet()
else if (command === "run") await run()
else if (command === "episode") await episode()
else if (command === "summary") summary()
else console.log("usage: eval export|run|episode|summary (see src/eval/cli.ts)")
