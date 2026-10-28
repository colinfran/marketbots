import type { WireItemDoc, WireTriggerDoc } from "@mb/core/wire"
import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import type { Collection } from "mongodb"

export { pglite } from "../src/testing"

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
