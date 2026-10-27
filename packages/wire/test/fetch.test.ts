import { describe, expect, it, vi } from "vitest"
import { WireFetch } from "../src/fetch"
import { rateFor } from "../src/limiter"
import { BROWSER_HEADERS } from "../src/sources/common"

describe("wire fetch", () => {
  it("sends conditional GETs and treats 304 as no change", async () => {
    const request = vi.fn()
    request.mockResolvedValueOnce({ status: 200, text: "{}", headers: new Headers({ etag: '"v1"' }) })
    request.mockResolvedValueOnce({ status: 304, text: "", headers: new Headers() })
    const f = new WireFetch({ take: async () => undefined }, "Test/1 a@b.c", request)
    expect(await f.json("https://x.test/a")).toEqual({})
    expect(await f.json("https://x.test/a")).toBeNull()
    expect(request.mock.calls[1][1].headers["if-none-match"]).toBe('"v1"')
    expect(request.mock.calls[0][1].headers["user-agent"]).toBe("Test/1 a@b.c")
    expect(rateFor("www.sec.gov").key).toBe("sec.gov")
    expect(rateFor("efts.sec.gov").rate.perSecond).toBe(4)
  })

  it("a spec's browser User-Agent replaces the wire's own", async () => {
    const request = vi.fn(async () => ({ status: 200, text: "{}", headers: new Headers() }))
    const f = new WireFetch({ take: async () => undefined }, "StockMarketBot/1 a@b.c", request)
    await f.get("https://api.nasdaq.com/api/calendar/earnings?date=2026-10-27", { headers: { ...BROWSER_HEADERS, accept: "application/json" } })
    const headers = (request.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers
    expect(headers["user-agent"]).toBe(BROWSER_HEADERS["user-agent"])
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === "user-agent")).toHaveLength(1)
  })
})
