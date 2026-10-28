import type { WireItemDoc, WireTriggerDoc } from "@mb/core/wire"
import type { Collection } from "mongodb"
import type { Sql } from "./sql"

/**
 * The news archive (docs/plans/LOCAL-AI.md §6.2): every wire item and trigger, copied from MongoDB
 * before its TTL deletes it, and kept for good. Items change after they're first seen (a
 * confirmation, an article summary, notable), so `append` copies what's new every minute and
 * `sync` copies a window again (nightly, and at start), replacing what changed. The whole document
 * goes into `doc`; the columns beside it are for queries.
 */

const BATCH = 500
/** `append` looks back this far past the newest archived item: inserts don't arrive in exact time order. */
const OVERLAP_MS = 10 * 60_000

/** The MongoDB document as JSON. Postgres refuses NUL characters in text and jsonb, so they go. */
const toJson = (docs: unknown[]) => JSON.stringify(docs).replace(/\\u0000/g, "")

type ItemRow = { id: string; first_seen_at: Date; source: string; tier: number; kind: string; category: string; title: string; url: string | null; domain: string | null; symbols: string[]; severity: number; cluster_id: string; doc: unknown }
type TriggerRow = { id: string; at: Date; rule: string; action: string; status: string; symbols: string[]; severity: number; item_ids: string[]; cycle_id: string | null; doc: unknown }

const itemRow = (d: WireItemDoc<string>): ItemRow => ({
  id: d._id,
  first_seen_at: d.first_seen_at,
  source: d.source,
  tier: d.tier,
  kind: d.kind,
  category: d.category,
  title: d.title,
  url: d.url,
  domain: d.domain,
  symbols: d.symbols,
  severity: Math.round(d.severity),
  cluster_id: d.cluster_id,
  doc: d,
})

const triggerRow = (d: WireTriggerDoc): TriggerRow => ({
  id: d._id,
  at: d.at,
  rule: d.rule,
  action: d.action,
  status: d.status,
  symbols: d.symbols,
  severity: Math.round(d.severity),
  item_ids: d.item_ids,
  cycle_id: d.cycle_id,
  doc: d,
})

const upsertItems = (sql: Sql, rows: ItemRow[]) =>
  sql.query(
    `insert into news_items (id, first_seen_at, source, tier, kind, category, title, url, domain, symbols, severity, cluster_id, doc)
     select id, first_seen_at, source, tier, kind, category, title, url, domain, symbols, severity, cluster_id, doc
     from jsonb_to_recordset($1::jsonb) as x(id text, first_seen_at timestamptz, source text, tier smallint, kind text, category text, title text, url text, domain text, symbols text[], severity integer, cluster_id text, doc jsonb)
     on conflict (id) do update set first_seen_at = excluded.first_seen_at, source = excluded.source, tier = excluded.tier, kind = excluded.kind, category = excluded.category,
       title = excluded.title, url = excluded.url, domain = excluded.domain, symbols = excluded.symbols, severity = excluded.severity, cluster_id = excluded.cluster_id, doc = excluded.doc, updated_at = now()
     where news_items.doc is distinct from excluded.doc`,
    [toJson(rows)],
  )

const upsertTriggers = (sql: Sql, rows: TriggerRow[]) =>
  sql.query(
    `insert into news_triggers (id, at, rule, action, status, symbols, severity, item_ids, cycle_id, doc)
     select id, at, rule, action, status, symbols, severity, item_ids, cycle_id, doc
     from jsonb_to_recordset($1::jsonb) as x(id text, at timestamptz, rule text, action text, status text, symbols text[], severity integer, item_ids text[], cycle_id text, doc jsonb)
     on conflict (id) do update set at = excluded.at, rule = excluded.rule, action = excluded.action, status = excluded.status, symbols = excluded.symbols,
       severity = excluded.severity, item_ids = excluded.item_ids, cycle_id = excluded.cycle_id, doc = excluded.doc, updated_at = now()
     where news_triggers.doc is distinct from excluded.doc`,
    [toJson(rows)],
  )

export type ArchiveStatus = { items: number; triggers: number; last_append_at: Date | null; last_sync_at: Date | null; last_error: string | null }

export class NewsArchive<C extends string> {
  private lastAppendAt: Date | null = null
  private lastSyncAt: Date | null = null
  private counts = { items: 0, triggers: 0 }

  constructor(private readonly col: { wireItems: Collection<WireItemDoc<C>>; wireTriggers: Collection<WireTriggerDoc> }) {}

  /** Copies items and triggers first seen since the newest archived one (less a short overlap). Returns how many were copied. */
  async append(sql: Sql, now = new Date()): Promise<number> {
    const newest = (await sql.query<{ items: Date | null; triggers: Date | null }>("select (select max(first_seen_at) from news_items) as items, (select max(at) from news_triggers) as triggers")).rows[0]
    const since = (d: Date | null | undefined) => (d ? new Date(new Date(d).getTime() - OVERLAP_MS) : new Date(0))
    const copied = (await this.copyItems(sql, { first_seen_at: { $gte: since(newest?.items) } })) + (await this.copyTriggers(sql, { at: { $gte: since(newest?.triggers) } }))
    this.lastAppendAt = now
    await this.count(sql)
    return copied
  }

  /** Copies again every item and trigger first seen in the last `days` days, so later changes reach the archive. */
  async sync(sql: Sql, days: number, now = new Date()): Promise<number> {
    const from = new Date(now.getTime() - days * 86_400_000)
    const copied = (await this.copyItems(sql, { first_seen_at: { $gte: from } })) + (await this.copyTriggers(sql, { at: { $gte: from } }))
    this.lastSyncAt = now
    await this.count(sql)
    return copied
  }

  /** True until something has been archived (the first sync then copies everything MongoDB still has). */
  async empty(sql: Sql) {
    return (await sql.query("select 1 from news_items limit 1")).rows.length === 0
  }

  status(lastError: string | null): ArchiveStatus {
    return { ...this.counts, last_append_at: this.lastAppendAt, last_sync_at: this.lastSyncAt, last_error: lastError }
  }

  private async copyItems(sql: Sql, filter: Record<string, unknown>) {
    let n = 0
    let batch: ItemRow[] = []
    for await (const d of this.col.wireItems.find(filter).sort({ first_seen_at: 1 })) {
      batch.push(itemRow(d as WireItemDoc<string>))
      if (batch.length >= BATCH) {
        await upsertItems(sql, batch)
        n += batch.length
        batch = []
      }
    }
    if (batch.length) await upsertItems(sql, batch)
    return n + batch.length
  }

  private async copyTriggers(sql: Sql, filter: Record<string, unknown>) {
    let n = 0
    let batch: TriggerRow[] = []
    for await (const d of this.col.wireTriggers.find(filter).sort({ at: 1 })) {
      batch.push(triggerRow(d))
      if (batch.length >= BATCH) {
        await upsertTriggers(sql, batch)
        n += batch.length
        batch = []
      }
    }
    if (batch.length) await upsertTriggers(sql, batch)
    return n + batch.length
  }

  private async count(sql: Sql) {
    const r = (await sql.query<{ items: string; triggers: string }>("select (select count(*) from news_items) as items, (select count(*) from news_triggers) as triggers")).rows[0]
    this.counts = { items: Number(r?.items ?? 0), triggers: Number(r?.triggers ?? 0) }
  }
}
