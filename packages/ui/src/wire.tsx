"use client"

import type { BaseEventDataMap } from "@mb/core/events"
import type { DossierRow, NotableReason, WireSourceHealth } from "@mb/core/wire"
import { cn } from "cn"
import { ZapIcon } from "lucide-react"
import { useMemo } from "react"
import { SymbolLink } from "./bits"
import { Badge } from "./components/badge"
import { useKit } from "./kit"
import { ago, titleCase } from "./lib/format"
import { useNow } from "./live"
import { type AnyEvent, useStream } from "./stream"

/**
 * The news engine ("wire") on the dashboard: items our feeds saw, why an item matters, the
 * triggers it fired and how each source is doing. Everything shown is plain text from sanitized,
 * length-capped fields; links open the source in a new tab. Rows carry no feed summaries: Benzinga
 * items (via Alpaca) may show only their headline, source and link, and that holds for all rows.
 * What a row may carry is our local model's summary of the article (never Benzinga's), on the
 * News page and an item's detail, labelled as a machine summary that may contain errors.
 * Who published an item, symbol links and times come from the bot's kit.
 */

/** The wire events have the same payload in both bots (only the categories differ). */
type WireEvent = BaseEventDataMap<string, string, string>

export type WireRowView = {
  id: string
  title: string
  url: string | null
  source: string
  domain: string | null
  tier: 1 | 2 | 3
  category: string
  kind: string
  symbols: string[]
  severity: number
  first_seen_at: string
  notable: boolean
  notable_reasons: NotableReason[]
  price_at_seen: Record<string, number>
  /** The local model's summary of the article, when it passed every check. */
  article: ArticleView | null
}

export type ArticleView = { summary: string; key_points: string[]; model: string; at: string }

export type TriggerView = {
  id: string
  at: string
  rule: string
  action: string
  status: string
  reason: string
  symbols: string[]
  severity: number
  /** The page of the cycle it started (crypto: the cycle's research page; stock: its report). */
  item_title: string | null
}

const TIER_LABEL = { 1: "official", 2: "outlet", 3: "aggregator" } as const

export function SeverityBadge({ severity }: { severity: number }) {
  // Bands at the default thresholds: critical, evaluate an entry, review a holding.
  const style = severity >= 85 ? "bg-red-500/15 text-red-700 dark:text-red-300" : severity >= 70 ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : severity >= 55 ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : "bg-muted text-muted-foreground"
  return (
    <Badge variant="outline" className={cn("border-transparent font-mono tabular-nums", style)} title="Severity, 0-100, computed in code">
      {severity}
    </Badge>
  )
}

const WHY: Record<NotableReason, (symbols: string[]) => string> = {
  triggered: (s) => `Triggered a review${s.length ? ` of ${s.join(", ")}` : ""}`,
  held: (s) => `You hold ${s.join(", ")}`,
  focus: (s) => `On the radar: ${s.join(", ")}`,
  market: () => "Market-wide",
  cited: () => "Cited by the AI",
}

export function WhyChips({ reasons, symbols }: { reasons: NotableReason[]; symbols: string[] }) {
  if (!reasons.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <span key={r} className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
          {WHY[r](symbols)}
        </span>
      ))}
    </span>
  )
}

/** The price move since we first saw the item, from the live ticker (streamed symbols only). */
export function MoveSince({ symbol, then }: { symbol: string; then: number | undefined }) {
  const { tickers } = useStream()
  const now = tickers[symbol]?.last
  if (!then || !now) return null
  const pct = (now / then - 1) * 100
  return (
    <span className={cn("font-mono text-[11px] tabular-nums", pct > 0.05 ? "text-gain" : pct < -0.05 ? "text-loss" : "text-muted-foreground")} title="Move since first seen">
      {pct >= 0 ? "+" : "−"}
      {Math.abs(pct).toFixed(1)}% since
    </span>
  )
}

function ItemTitle({ title, url }: { title: string; url: string | null }) {
  if (!url) return <>{title}</>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
      {title}
    </a>
  )
}

const MODEL_LABEL: Record<string, string> = { "qwen3.6-35b-a3b-q2": "Qwen 3.6 35B-A3B", "llama3.2:3b": "Llama 3.2 3B" }

/** The local model's summary of an item's article, always labelled as a machine summary, with the article's link. */
export function ArticleSummary({ article, url, open = false }: { article: ArticleView; url: string | null; open?: boolean }) {
  return (
    <details className="text-xs" open={open}>
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer">Machine summary ({MODEL_LABEL[article.model] ?? article.model}, may contain errors)</summary>
      <div className="mt-1 space-y-1 border-l-2 pl-2">
        <p className="leading-snug">{article.summary}</p>
        {article.key_points.length > 0 && (
          <ul className="text-muted-foreground list-disc space-y-0.5 pl-4">
            {article.key_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-muted-foreground hover:text-foreground inline-block underline underline-offset-2">
            Read the article
          </a>
        )}
      </div>
    </details>
  )
}

/** One item. `summary` shows its article's machine summary, if it has one: folded in the News page's list, open on an item's detail. */
export function WireItemRow({ item, showWhy = false, summary }: { item: WireRowView; showWhy?: boolean; summary?: "folded" | "open" }) {
  const { format, sourceLabel, symbolHref } = useKit()
  const now = useNow(30_000)
  return (
    <li className="flex gap-2.5 py-2">
      <SeverityBadge severity={item.severity} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm leading-snug">
          <ItemTitle title={item.title} url={item.url} />
        </p>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <time dateTime={item.first_seen_at} title={format.dateTime(item.first_seen_at)}>
            {ago(item.first_seen_at, now)}
          </time>
          {item.symbols.map((s) => (
            <SymbolLink key={s} symbol={s} href={symbolHref(s)} />
          ))}
          <span>{titleCase(item.category)}</span>
          {item.source && (
            <span>
              {sourceLabel(item.source, item.domain)} · T{item.tier} {TIER_LABEL[item.tier]}
            </span>
          )}
          {item.symbols.length === 1 && <MoveSince symbol={item.symbols[0]} then={item.price_at_seen[item.symbols[0]]} />}
        </p>
        {showWhy && <WhyChips reasons={item.notable_reasons} symbols={item.symbols} />}
        {summary && item.article && <ArticleSummary article={item.article} url={item.url} open={summary === "open"} />}
      </div>
    </li>
  )
}

/** Items the AI was given from our feeds, as compact rows: severity, title, symbols, source (cycle trail, report pages). */
export function DossierRows({ rows, showTime = false }: { rows: DossierRow<string>[]; showTime?: boolean }) {
  const { format, sourceLabel } = useKit()
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((row) => (
        <li key={row.id} className="flex gap-2">
          <span className="text-muted-foreground w-6 shrink-0 text-right font-mono tabular-nums" title="severity">
            {row.severity}
          </span>
          <span className="min-w-0">
            <ItemTitle title={row.title} url={row.url} />
            <span className="text-muted-foreground">
              {" "}
              · {showTime && `${format.dateTime(row.at)} · `}
              {row.symbols.join(", ") || "market-wide"} · {titleCase(row.category)} · {sourceLabel(row.source)} · T{row.tier}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

const fromEvent = (e: AnyEvent): WireRowView | null => {
  if (e.type !== "wire.item") return null
  const d = e.data as WireEvent["wire.item"]
  return { id: d.id, title: d.title, url: d.url, source: d.source, domain: null, tier: d.tier, category: d.category, kind: d.kind, symbols: d.symbols, severity: d.severity, first_seen_at: d.first_seen_at, notable: d.notable, notable_reasons: d.notable_reasons, price_at_seen: {}, article: null }
}

/** Server-rendered items plus everything the stream adds. */
function useWireItems(initial: WireRowView[], filter?: (i: WireRowView) => boolean) {
  const { events } = useStream()
  return useMemo(() => {
    const byId = new Map(initial.map((i) => [i.id, i]))
    for (const e of [...events].reverse()) {
      const row = fromEvent(e)
      if (row && !byId.has(row.id)) byId.set(row.id, row)
      if (e.type === "wire.notable") {
        const d = e.data as WireEvent["wire.notable"]
        const known = byId.get(d.id)
        if (known) byId.set(d.id, { ...known, notable: true, notable_reasons: d.notable_reasons })
        else byId.set(d.id, { id: d.id, title: d.title, url: null, source: "", domain: null, tier: 2, category: "general", kind: "news", symbols: d.symbols, severity: d.severity, first_seen_at: e.ts, notable: true, notable_reasons: d.notable_reasons, price_at_seen: {}, article: null })
      }
    }
    return [...byId.values()].filter((i) => !filter || filter(i)).sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at))
  }, [initial, events, filter])
}

export type WireListFilter = { symbol?: string; category?: string; source?: string; minSeverity?: number }

/** The News page's list: everything stored, live, with the page's filters applied to new items too, and machine summaries folded under their items. */
export function LiveWireList({ initial, limit = 100, filter = {} }: { initial: WireRowView[]; limit?: number; filter?: WireListFilter }) {
  const { symbol, category, source, minSeverity } = filter
  const predicate = useMemo(
    () => (i: WireRowView) => (!symbol || i.symbols.includes(symbol)) && (!category || i.category === category) && (!source || i.source === source) && (!minSeverity || i.severity >= minSeverity),
    [symbol, category, source, minSeverity],
  )
  const items = useWireItems(initial, predicate).slice(0, limit)
  if (!items.length) return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">Nothing matches yet.</p>
  return (
    <ol className="divide-y" aria-live="polite">
      {items.map((i) => (
        <WireItemRow key={i.id} item={i} showWhy={i.notable} summary="folded" />
      ))}
    </ol>
  )
}

const STATE_STYLE: Record<string, string> = {
  ok: "bg-gain",
  starting: "bg-sky-500",
  degraded: "bg-amber-500",
  down: "bg-loss",
  disabled: "bg-muted-foreground/40",
}

/** One dot per source; hover for details. */
export function SourceHealthStrip({ sources }: { sources: WireSourceHealth[] }) {
  const ok = sources.filter((s) => s.state === "ok").length
  const running = sources.filter((s) => s.state !== "disabled").length
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        {ok} of {running} running sources healthy{sources.length > running ? ` · ${sources.length - running} off` : ""}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <li key={s.id} title={`${s.id}: ${s.state}${s.last_error ? ` (${s.last_error})` : ""}${s.detail ? ` · ${s.detail}` : ""} · ${s.items_24h} items / 24 h`} className="bg-muted/50 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]">
            <span className={cn("size-1.5 rounded-full", STATE_STYLE[s.state] ?? "bg-muted-foreground")} aria-hidden />
            <span className="font-mono">{s.id}</span>
            <span className="text-muted-foreground tabular-nums">{s.items_24h}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const TRIGGER_STYLE: Record<string, string> = {
  fired: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  queued: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  suppressed: "bg-muted text-muted-foreground",
  shadow: "bg-muted text-muted-foreground",
}

/** Stored triggers plus the ones the stream adds (fired, queued and suppressed alike). */
export function TriggerList({ triggers, limit = 40 }: { triggers: TriggerView[]; limit?: number }) {
  const { format } = useKit()
  const now = useNow(30_000)
  const { events } = useStream()
  const rows = useMemo(() => {
    const known = new Set(triggers.map((t) => t.id))
    const titles = new Map<string, string>()
    for (const e of events) if (e.type === "wire.item" || e.type === "wire.notable") titles.set((e.data as { id: string }).id, (e.data as { title: string }).title)
    const live = events
      .filter((e) => e.type === "wire.trigger" && !known.has((e.data as WireEvent["wire.trigger"]).trigger_id))
      .map((e): TriggerView => {
        const d = e.data as WireEvent["wire.trigger"]
        return { id: d.trigger_id, at: e.ts, rule: d.rule, action: d.action, status: d.status, reason: d.reason, symbols: d.symbols, severity: d.severity, item_title: titles.get(d.item_ids[0] ?? "") ?? null }
      })
    return [...live, ...triggers].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  }, [triggers, events, limit])
  if (!rows.length) return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">No triggers yet.</p>
  return (
    <ol className="divide-y text-sm" aria-live="polite">
      {rows.map((t) => (
        <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
          <ZapIcon className="text-muted-foreground size-3.5 self-center" aria-hidden />
          <Badge variant="outline" className={cn("border-transparent", TRIGGER_STYLE[t.status])}>
            {titleCase(t.status)}
          </Badge>
          <span className="font-medium">{titleCase(t.rule)}</span>
          <span className="text-muted-foreground text-xs">
            {titleCase(t.action)} · {t.symbols.join(", ") || "market"} · sev {t.severity}
          </span>
          <time className="text-muted-foreground ml-auto text-xs" dateTime={t.at} title={format.dateTime(t.at)}>
            {ago(t.at, now)}
          </time>
          {t.item_title && <span className="text-muted-foreground basis-full text-xs">{t.item_title}</span>}
          <span className="text-muted-foreground basis-full text-xs">{t.reason}</span>
        </li>
      ))}
    </ol>
  )
}
