import type { BaseEventDataMap } from "@mb/core/events"
import type { WireSettingsBase } from "@mb/core/settings"
import type { WireKind, WireSourceHealth, WireTier } from "@mb/core/wire"
import type { EmitMeta } from "@mb/engine-kit/bus"
import type { Logger } from "@mb/engine-kit/log"
import type { WireFetch } from "./fetch"

/**
 * The news engine's building blocks. A source produces RawItems; the Wire normalizes, dedupes,
 * clusters, tags, scores and stores them. Most sources are a catalog entry (a SourceSpec of a
 * generic kind: RSS, JSON, HTML, Statuspage, Telegram preview, list diff); the few that stream or
 * need custom logic provide `create`.
 *
 * The types are generic over a bot's wire categories (`C`) and its `wire` settings section (`W`);
 * each engine binds them in its own wire/types.ts. Shared code takes items and entries with the
 * defaults (any category, the base settings), and types what it makes with the categories it sets
 * itself (`macro_release`, `odds_swing`…, or `never` when it sets none), so a bot's compiler checks
 * them against its own list. Function members are declared as methods, so their parameters
 * compare bivariantly: a bot's catalog entries go to the shared pollers, and a shared source sits
 * in a bot's catalog.
 */

type WireEvents<C extends string> = Pick<BaseEventDataMap<C, string, string>, "wire.item" | "wire.notable" | "wire.source" | "wire.trigger">

/** The part of the engine's event bus the news engine and its trigger policy emit on. */
export type WireEventSink<C extends string> = { emit<T extends keyof WireEvents<C>>(type: T, data: WireEvents<C>[T], meta: EmitMeta): unknown }

/** What a source hands the pipeline. Everything in it is untrusted until normalize() has run. */
export type RawItem<C extends string = string> = {
  /** The source's own id (guid, accession number, post id). Without one the URL, then the title, is the identity. */
  sourceId?: string | null
  title: string
  summary?: string | null
  url?: string | null
  publishedAt?: Date | null
  /** Set by adapters that know better than the lexicon. */
  symbols?: string[]
  category?: C
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
export type Emit<C extends string = string> = (items: RawItem<C>[], opts?: { backfill?: boolean }) => Promise<void>

export type SymbolSets = { universe: string[]; held: string[]; focus: string[] }

/** What every source gets from the Wire. */
export type SourceContext<W extends WireSettingsBase = WireSettingsBase> = {
  fetch: WireFetch
  log: Logger
  env: Readonly<Record<string, string | undefined>>
  symbols: () => SymbolSets
  now: () => Date
  /** The live `wire` settings (thresholds that sources apply themselves, such as extreme funding). */
  settings: () => W
}

export type SourceKind = "rss" | "json" | "html" | "headless" | "statuspage" | "telegram" | "diff" | "custom"

export type SourceSpec<C extends string = string, W extends WireSettingsBase = WireSettingsBase> = {
  /** Unique catalog id, e.g. "rss:coindesk". */
  id: string
  kind: SourceKind
  url?: string
  /** Per-symbol feeds: polled round-robin, one symbol per tick. */
  urlFor?(symbol: string): string
  /** Which symbols `urlFor` cycles through. */
  symbols?: "universe" | "held+focus"
  interval_s: number
  tier: WireTier
  /** Default item kind (news unless set). */
  wire_kind?: WireKind
  /** Category when the lexicon finds nothing more specific. */
  category_hint?: C
  /** The source stays off until this env var is set. */
  key_env?: string
  default_enabled: boolean
  headers?(env: SourceContext["env"]): Record<string, string>
  /** json / diff: payload → items (json) or → keyed entries (diff). headless with `render.capture`: the captured responses → items. */
  map?(body: unknown, ctx: SourceContext<W>): RawItem<C>[]
  /** rss / telegram: adjusts the parsed items (drops noise, tags the symbols a feed is about, sets a category). */
  refine?(items: RawItem<C>[], ctx: SourceContext<W>): RawItem<C>[]
  /** diff: payload → entries keyed by id; added, removed and changed entries become items. */
  entries?(body: unknown): Map<string, string>
  describe?(change: { type: "added" | "removed" | "changed"; key: string; before: string | null; after: string | null }, ctx: SourceContext<W>): RawItem<C> | null
  /** html / headless: cheerio selectors, or a custom mapper. */
  selectors?: { item: string; title: string; link?: string; time?: string; summary?: string }
  mapHtml?(html: string, ctx: SourceContext<W>): RawItem<C>[]
  /**
   * headless: how the scraper sidecar renders the page. `wait_for`: a CSS selector to wait for;
   * `capture`: URL substrings of the page's own responses to hand to `map` instead of the HTML.
   */
  render?: { wait_for?: string; timeout_ms?: number; capture?: string[] }
  /** telegram: the public channel name (t.me/s/<channel>). */
  channel?: string
  /** custom sources (streams, multi-step APIs). */
  create?(spec: SourceSpec<C, W>, ctx: SourceContext<W>): WireSource<C>
  note?: string
}

export interface WireSource<C extends string = string> {
  readonly id: string
  readonly tier: WireTier
  start(emit: Emit<C>, signal: AbortSignal): void
  stop(): void
  health(): WireSourceHealth
}

/** Per-bot language rules (wire/lexicon.ts in each engine): symbol tagging, categories, direction hints. */
export type Lexicon<C extends string = string> = {
  /** Bot symbols mentioned in the text, from the given set. */
  tag(text: string, symbols: readonly string[]): string[]
  classify(text: string, hint?: C): C
  polarity(text: string): -1 | 0 | 1
  /** Whether an item that names no symbol still matters to the whole market (macro, policy, regulation). */
  marketWide(text: string, category: C): boolean
  /** Severity points a matching volume-only anomaly adds (a price anomaly always adds 15). */
  volumeAnomalyPoints: number
  /** A base severity that depends on the text (e.g. an exploit scaled by the amount lost), or undefined for the category default. */
  baseSeverity?(text: string, category: C): number | undefined
}
