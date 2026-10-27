// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import type { Settings } from "@mb/stock-core/settings"
import type { WireCategory, WireKind, WireSourceHealth, WireTier } from "@mb/stock-core/wire"
import type { Logger } from "@mb/engine-kit/log"
import type { WireFetch } from "./fetch"

/**
 * The news engine's building blocks. A source produces RawItems; the Wire normalizes, dedupes,
 * clusters, tags, scores and stores them. Most sources are a catalog entry (a SourceSpec of a
 * generic kind: RSS, JSON, HTML, Statuspage, Telegram preview, list diff); the few that stream or
 * need custom logic provide `create`.
 */

/** What a source hands the pipeline. Everything in it is untrusted until normalize() has run. */
export type RawItem = {
  /** The source's own id (guid, accession number, post id). Without one the URL, then the title, is the identity. */
  sourceId?: string | null
  title: string
  summary?: string | null
  url?: string | null
  publishedAt?: Date | null
  /** Set by adapters that know better than the lexicon. */
  symbols?: string[]
  category?: WireCategory
  kind?: WireKind
  tier?: WireTier
  polarity?: -1 | 0 | 1
  /** Market-wide by construction (macro, policy, our market-shock detector). */
  marketWide?: boolean
  /** Replaces the category base, e.g. a price shock scaled by its z-score. */
  baseSeverity?: number
  meta?: Record<string, string | number | boolean | null>
}

/** `backfill`: items a source found on its first poll or stream snapshot. They are stored but can never trigger. */
export type Emit = (items: RawItem[], opts?: { backfill?: boolean }) => Promise<void>

export type SymbolSets = { universe: string[]; held: string[]; focus: string[] }

/** What every source gets from the Wire. */
export type SourceContext = {
  fetch: WireFetch
  log: Logger
  env: Readonly<Record<string, string | undefined>>
  symbols: () => SymbolSets
  now: () => Date
  /** The live `wire` settings (thresholds that sources apply themselves, such as extreme funding). */
  settings: () => Settings["wire"]
}

export type SourceKind = "rss" | "json" | "html" | "headless" | "statuspage" | "telegram" | "diff" | "custom"

export type SourceSpec = {
  /** Unique catalog id, e.g. "rss:coindesk". */
  id: string
  kind: SourceKind
  url?: string
  /** Per-symbol feeds: polled round-robin, one symbol per tick. */
  urlFor?: (symbol: string) => string
  /** Which symbols `urlFor` cycles through. */
  symbols?: "universe" | "held+focus"
  interval_s: number
  tier: WireTier
  /** Default item kind (news unless set). */
  wire_kind?: WireKind
  /** Category when the lexicon finds nothing more specific. */
  category_hint?: WireCategory
  /** The source stays off until this env var is set. */
  key_env?: string
  default_enabled: boolean
  headers?: (env: SourceContext["env"]) => Record<string, string>
  /** json / diff: payload → items (json) or → keyed entries (diff). headless with `render.capture`: the captured responses → items. */
  map?: (body: unknown, ctx: SourceContext) => RawItem[]
  /** rss / telegram: adjusts the parsed items (drops noise, tags the symbols a feed is about, sets a category). */
  refine?: (items: RawItem[], ctx: SourceContext) => RawItem[]
  /** diff: payload → entries keyed by id; added, removed and changed entries become items. */
  entries?: (body: unknown) => Map<string, string>
  describe?: (change: { type: "added" | "removed" | "changed"; key: string; before: string | null; after: string | null }, ctx: SourceContext) => RawItem | null
  /** html / headless: cheerio selectors, or a custom mapper. */
  selectors?: { item: string; title: string; link?: string; time?: string; summary?: string }
  mapHtml?: (html: string, ctx: SourceContext) => RawItem[]
  /**
   * headless: how the scraper sidecar renders the page. `wait_for`: a CSS selector to wait for;
   * `capture`: URL substrings of the page's own responses to hand to `map` instead of the HTML.
   */
  render?: { wait_for?: string; timeout_ms?: number; capture?: string[] }
  /** telegram: the public channel name (t.me/s/<channel>). */
  channel?: string
  /** custom sources (streams, multi-step APIs). */
  create?: (spec: SourceSpec, ctx: SourceContext) => WireSource
  note?: string
}

export interface WireSource {
  readonly id: string
  readonly tier: WireTier
  start(emit: Emit, signal: AbortSignal): void
  stop(): void
  health(): WireSourceHealth
}

/** Per-bot language rules (wire/lexicon.ts): symbol tagging, categories, direction hints. */
export type Lexicon = {
  /** Bot symbols mentioned in the text, from the given set. */
  tag(text: string, symbols: readonly string[]): string[]
  classify(text: string, hint?: WireCategory): WireCategory
  polarity(text: string): -1 | 0 | 1
  /** Whether an item that names no symbol still matters to the whole market (macro, policy, regulation). */
  marketWide(text: string, category: WireCategory): boolean
  /** Severity points a matching volume-only anomaly adds (a price anomaly always adds 15). */
  volumeAnomalyPoints: number
  /** A base severity that depends on the text (e.g. an exploit scaled by the amount lost), or undefined for the category default. */
  baseSeverity?(text: string, category: WireCategory): number | undefined
}
