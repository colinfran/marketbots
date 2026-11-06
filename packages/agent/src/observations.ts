import { MARKET_SUBJECT, type Observation, type Priority } from "@mb/core/agent"
import type { WireItemDoc, WireTriggerAction } from "@mb/core/wire"
import { cleanLine } from "@mb/engine-kit/util/text"

/**
 * Observations both bots make the same way (docs/plans/LOCAL-AI.md §8.1). Each bot adds its own
 * (screens, price moves, sessions) in its engine's src/agent/.
 */

/**
 * A news trigger candidate that passed the wire's gates on the item itself (fresh, confirmed): one
 * observation per symbol it names, or one about the market. The trigger's hourly and daily caps
 * don't apply (they limit its alerts and the emergency exit): the envelope limits what the agent does.
 */
export const newsObservations = (
  item: Pick<WireItemDoc<string>, "_id" | "title" | "severity" | "first_seen_at" | "category" | "source">,
  c: { rule: string; action: WireTriggerAction; symbols: readonly string[] },
  { held, critical }: { held: ReadonlySet<string>; critical: number },
): Observation[] => {
  const subjects = c.symbols.length ? c.symbols : [MARKET_SUBJECT]
  return subjects.map((subject) => {
    const isHeld = held.has(subject)
    const priority: Priority =
      c.action === "emergency" || (c.action === "review" && isHeld) || (c.action === "market_review" && item.severity >= critical && held.size > 0)
        ? 0
        : c.action === "evaluate" || c.action === "gap_fill"
          ? 1
          : 2
    return {
      id: `news:${item._id}:${c.rule}:${subject}`,
      subject,
      kind: "news",
      priority,
      salience: Math.round(Math.max(0, Math.min(100, item.severity))),
      summary: `${c.rule.replace(/_/g, " ")} (${item.category}, severity ${item.severity}, ${item.source}): ${cleanLine(item.title, 220)}`,
      untrusted: true,
      refs: { item_ids: [item._id] },
      at: item.first_seen_at,
    }
  })
}

/**
 * Whether news about `symbol` woke this episode, or the owner asked for a review: the only times
 * the agent may close a position the trend core holds, which otherwise ends by the core's rules.
 */
export const newsWoke = (observations: readonly Pick<Observation, "id" | "kind" | "subject">[], symbol: string) =>
  observations.some((o) => (o.kind === "news" && o.subject === symbol) || o.id.startsWith("review:"))
