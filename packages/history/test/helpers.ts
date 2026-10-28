import { PGlite } from "@electric-sql/pglite"
import type { WireItemDoc, WireTriggerDoc } from "@mb/core/wire"
import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import type { Collection } from "mongodb"
import type { Sql } from "../src/sql"

/**
 * Postgres in-process (PGlite). Like node-postgres, a query without parameters may hold several
 * statements (PGlite runs those through exec); one with parameters is a single statement.
 */
export const pglite = (): Sql & { close(): Promise<void> } => {
  const db = new PGlite()
  return {
    query: async <R>(text: string, params?: unknown[]) => {
      if (params?.length) return (await db.query<R>(text, params)) as { rows: R[] }
      const results = await db.exec(text)
      return { rows: (results.at(-1)?.rows ?? []) as R[] }
    },
    close: () => db.close(),
  }
}

export type WireCol = { wireItems: Collection<WireItemDoc<string>>; wireTriggers: Collection<WireTriggerDoc> }

export const useWireDb = () =>
  useMongoTestDb<WireCol>({ prefix: "history", indexes: {}, collections: (db) => ({ wireItems: db.collection("wire_items"), wireTriggers: db.collection("wire_triggers") }) })

export const item = (id: string, at: Date, over: Partial<WireItemDoc<string>> = {}): WireItemDoc<string> => ({
  _id: id,
  cluster_id: id,
  source: "coindesk",
  tier: 2,
  kind: "news",
  category: "listing",
  title: `Headline ${id}`,
  summary: null,
  url: `https://example.com/${id}`,
  domain: "example.com",
  symbols: ["BTC/USD"],
  published_at: at,
  first_seen_at: at,
  polarity: 1,
  severity: 42.4,
  severity_parts: { base: 40 },
  confirmations: [],
  price_at_seen: { "BTC/USD": 64000 },
  meta: {},
  notable: false,
  notable_reasons: [],
  expires_at: new Date(at.getTime() + 30 * 86_400_000),
  ...over,
})

export const trigger = (id: string, at: Date, over: Partial<WireTriggerDoc> = {}): WireTriggerDoc => ({
  _id: id,
  at,
  rule: "held_negative",
  action: "review",
  status: "fired",
  reason: "severity 70 on a holding",
  item_ids: ["a"],
  symbols: ["BTC/USD"],
  severity: 70,
  cycle_id: null,
  queue_wait_ms: null,
  expires_at: new Date(at.getTime() + 30 * 86_400_000),
  ...over,
})
