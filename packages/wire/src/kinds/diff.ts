import type { PollFn } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"

/**
 * Watches a list (a venue's trading pairs, an exchange's products) and turns additions, removals
 * and changes into items. The first poll after start only records the baseline, so a restart
 * never reports every existing pair as new.
 */

export type DiffChange = { type: "added" | "removed" | "changed"; key: string; before: string | null; after: string | null }

export const diffEntries = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): DiffChange[] => {
  const changes: DiffChange[] = []
  for (const [key, value] of after) {
    const old = before.get(key)
    if (old === undefined) changes.push({ type: "added", key, before: null, after: value })
    else if (old !== value) changes.push({ type: "changed", key, before: old, after: value })
  }
  for (const [key, value] of before) if (!after.has(key)) changes.push({ type: "removed", key, before: value, after: null })
  return changes
}

/** A list shrinking by more than this share at once is a broken response, not mass delistings. */
const MAX_REMOVED_SHARE = 0.2

export const diffPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  if (!spec.entries || !spec.describe) throw new Error(`${spec.id}: a diff source needs entries and describe`)
  let baseline: Map<string, string> | null = null
  return async () => {
    const body = await ctx.fetch.json<unknown>(spec.url!, { headers: spec.headers?.(ctx.env), conditional: false })
    if (body === null) return null
    const current = spec.entries!(body)
    if (!baseline) {
      baseline = current
      return []
    }
    const changes = diffEntries(baseline, current)
    const removed = changes.filter((c) => c.type === "removed").length
    if (removed > Math.max(3, baseline.size * MAX_REMOVED_SHARE)) throw new Error(`${spec.id}: ${removed} of ${baseline.size} entries vanished at once; ignoring this response`)
    baseline = current
    return changes.map((c) => spec.describe!(c, ctx)).filter((i): i is RawItem => i !== null)
  }
}
