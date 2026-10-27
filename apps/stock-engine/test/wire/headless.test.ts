import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import type { WireFetch } from "../../src/wire/fetch"
import { headlessPoller, type Rendered } from "../../src/wire/kinds/headless"
import { stockLexicon } from "../../src/wire/lexicon"
import type { RawItem, SourceContext, SourceSpec } from "../../src/wire/types"
import { Wire } from "../../src/wire/wire"

const env = { SCRAPER_URL: "http://scraper:8790/" }
const makeCtx = (fetch: Partial<Record<"postJson", unknown>> = {}, e: Record<string, string> = env) =>
  ({
    fetch: fetch as unknown as WireFetch,
    log: silentLogger,
    env: e,
    symbols: () => ({ universe: ["AAPL"], held: [], focus: [] }),
    now: () => new Date("2026-10-27T14:00:00Z"),
    settings: () => DEFAULT_SETTINGS.wire,
  }) satisfies SourceContext
const page = (over: Partial<SourceSpec> = {}): SourceSpec => ({ id: "headless:test", kind: "headless", url: "https://js.test/list", interval_s: 600, tier: 3, default_enabled: true, ...over })
const rendered = (over: Partial<Rendered> = {}): Rendered => ({ status: 200, url: "https://js.test/list", html: "", captured: [], ...over })

describe("headless sources (scraper sidecar)", () => {
  it("sends the render job to the sidecar and reads the rendered HTML with selectors", async () => {
    const postJson = vi.fn(async () => rendered({ html: '<ul><li class="row"><a href="/r/1">AAPL upgraded to Buy</a><time datetime="2026-10-27T13:00:00Z"></time></li></ul>' }))
    const items = await headlessPoller(page({ selectors: { item: "li.row", title: "a", time: "time" }, render: { wait_for: "li.row", timeout_ms: 20_000 } }), makeCtx({ postJson }))()
    expect(postJson).toHaveBeenCalledWith("http://scraper:8790/render", { url: "https://js.test/list", wait_for: "li.row", timeout_ms: 20_000, capture: [] }, { timeoutMs: 50_000 })
    expect(items).toEqual([{ title: "AAPL upgraded to Buy", url: "https://js.test/r/1", summary: null, publishedAt: new Date("2026-10-27T13:00:00Z") }])
  })

  it("hands the page's captured JSON responses to map", async () => {
    const captured = [{ url: "https://js.test/api/rows?page=1", status: 200, body: JSON.stringify({ rows: [{ id: 7, title: "AAPL unusual call volume" }] }) }]
    const postJson = vi.fn(async () => rendered({ captured }))
    const map = vi.fn((body: unknown) => (body as typeof captured).flatMap((c) => (JSON.parse(c.body) as { rows: { id: number; title: string }[] }).rows.map((r): RawItem => ({ sourceId: String(r.id), title: r.title }))))
    const items = await headlessPoller(page({ render: { capture: ["/api/rows"] }, map }), makeCtx({ postJson }))()
    expect(postJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ capture: ["/api/rows"], wait_for: null, timeout_ms: 30_000 }), expect.anything())
    expect(items).toEqual([{ sourceId: "7", title: "AAPL unusual call volume" }])
  })

  it("treats the site's own 403 as a block, so the source degrades like a plain fetch", async () => {
    const postJson = vi.fn(async () => rendered({ status: 403, html: "<title>Access denied</title>" }))
    await expect(headlessPoller(page({ mapHtml: () => [] }), makeCtx({ postJson }))()).rejects.toMatchObject({ status: 403 })
  })

  it("needs a way to read the page, and stays off without a sidecar", () => {
    expect(() => headlessPoller(page(), makeCtx())).toThrow(/needs map/)
    expect(() => headlessPoller(page({ render: { capture: ["/api"] }, mapHtml: () => [] }), makeCtx())).toThrow(/needs map/)
    const spec = page({ mapHtml: () => [] })
    const wireWith = (e: Record<string, string>) => new Wire({ col: {} as never, bus: {} as never, log: silentLogger, settings: () => DEFAULT_SETTINGS.wire, catalog: [spec], lexicon: stockLexicon, env: e, symbols: () => ({ universe: ["AAPL"], held: [], focus: [] }), price: () => null, userAgent: "test" })
    expect(wireWith({}).disabledReason(spec)).toMatch(/SCRAPER_URL not set/)
    expect(wireWith(env).disabledReason(spec)).toBeNull()
  })
})
