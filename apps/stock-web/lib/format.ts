/** Display formatting, shared by server and client components. Times are shown in New York time, like the market. */

import { MARKET_TZ } from "@mb/stock-core/time"
import { zonedFormat } from "@mb/ui/lib/format"

export { ago, duration, num, pct, titleCase, tone, until, usd } from "@mb/ui/lib/format"

export const qty = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(4))

export const price = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`)

const WIRE_SOURCE_LABEL: Record<string, string> = { alpaca_news: "Benzinga via Alpaca" }

/** Who published a news-engine item: Benzinga headlines reach us through Alpaca, so both get the credit. */
export const wireSource = (source: string, domain?: string | null) => WIRE_SOURCE_LABEL[source] ?? domain ?? source

/** "10:30:15 AM" in New York time (for live feeds). */
export const { time, dateTime } = zonedFormat(MARKET_TZ)

/** Where a decision's reasoning lives: the agent's episode (decisions from before the agent keep only their own rationale). */
export const decisionHref = (d: { agent_episode_id?: string | null }) => (d.agent_episode_id ? `/agent/${d.agent_episode_id}` : null)
