import { cleanLine, fenceUntrusted } from "@mb/engine-kit/util/text"

/**
 * How the agent's history tools put years of data into a few lines (docs/plans/LOCAL-AI.md §8.3):
 * numbers code computed, never raw bar dumps. Both bots' tools use these with their history store.
 */

/** "+1.23%" from a fraction; "n/a" for nothing. */
export const signedPct = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`)

/** A run of daily bars described: return, range, volatility, worst drawdown, the biggest days, weekly closes. */
export const describeDailyBars = (symbol: string, bars: readonly { day: string; high: number; low: number; close: number }[]) => {
  if (bars.length < 2) return `${symbol}: not enough daily bars in the history store`
  const first = bars[0].close
  const last = bars.at(-1)!.close
  const returns = bars.slice(1).map((b, i) => b.close / bars[i].close - 1)
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const vol = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1))
  let peak = bars[0].close
  let worst = 0
  for (const b of bars) {
    peak = Math.max(peak, b.close)
    worst = Math.min(worst, b.close / peak - 1)
  }
  const high = bars.reduce((m, b) => (b.high > m.high ? b : m), bars[0])
  const low = bars.reduce((m, b) => (b.low < m.low ? b : m), bars[0])
  const days = returns
    .map((r, i) => ({ r, day: bars[i + 1].day }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 5)
  const weekly = bars.filter((_, i) => i % 5 === 0 || i === bars.length - 1).slice(-12)
  return [
    `${symbol}, ${bars[0].day} to ${bars.at(-1)!.day} (${bars.length} daily bars): ${signedPct(last / first - 1)}; high ${high.high} on ${high.day}, low ${low.low} on ${low.day}; daily volatility ${(vol * 100).toFixed(2)}%; worst drawdown ${signedPct(worst)}; now ${signedPct(last / high.high - 1)} from the high.`,
    `Biggest days: ${days.map((x) => `${x.day} ${signedPct(x.r)}`).join(", ")}.`,
    `Closes about weekly: ${weekly.map((b) => `${b.day.slice(5)} ${b.close}`).join(", ")}.`,
  ].join("\n")
}

/** Archived news with the moves after each item, fenced as untrusted (the titles come from outside). */
export const pastNewsText = (
  rows: readonly { first_seen_at: Date; severity: number; category: string; source: string; title: string; url: string | null; ret_1h: number | null; ret_1d: number | null; ret_5d: number | null }[],
) =>
  fenceUntrusted(
    "wire-archive",
    rows
      .map((r) => `- ${r.first_seen_at.toISOString().slice(0, 10)} sev ${r.severity} ${r.category.replace(/_/g, " ")} (${r.source}): ${cleanLine(r.title, 160)}${r.url ? ` (${r.url})` : ""} | after: 1 h ${signedPct(r.ret_1h)}, 1 d ${signedPct(r.ret_1d)}, 5 d ${signedPct(r.ret_5d)}`)
      .join("\n"),
  )
