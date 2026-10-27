import { afterEach, describe, expect, it, vi } from "vitest"
import { Alerts } from "../src/alerts"
import { silentLogger } from "../src/log"
import { fetchCall, mockFetch } from "../src/testing/fetch"
import { settle, useFakeClock } from "../src/testing/timers"

const WEBHOOK = "https://discord.example.com/hook"

// success() never touches the database or the bus: purchases are already stored and streamed.
const alerts = (webhook: string | null) => new Alerts({} as never, {} as never, silentLogger, webhook, "https://crypto.example.com/", "CryptoMarketBot")

/** Alerts whose stored notifications and emitted events are recorded. */
const recording = () => {
  const stored: unknown[] = []
  const emitted: unknown[] = []
  const col = { notifications: { insertOne: async (doc: unknown) => stored.push(doc) } }
  const bus = { emit: (...args: unknown[]) => emitted.push(args) }
  return { stored, emitted, alerts: new Alerts(col as never, bus, silentLogger, WEBHOOK, "https://bot.example.com", "TestBot") }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Alerts.success", () => {
  it("posts a green Discord embed with a dashboard link and fields, once per key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const a = alerts(WEBHOOK)
    const fields = { Quantity: 0.0307, Price: "$65,150.0", Stop: null }
    await a.success("Bought BTC/USD", "[paper] 4h breakout", { path: "/decisions/d1", key: "buy|o1", fields })
    await a.success("Bought BTC/USD", "[paper] 4h breakout", { path: "/decisions/d1", key: "buy|o1", fields })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(WEBHOOK)
    expect(JSON.parse(init.body)).toMatchObject({ username: "CryptoMarketBot" })
    expect(JSON.parse(init.body).embeds[0]).toMatchObject({
      title: "✅ Bought BTC/USD",
      description: "[paper] 4h breakout",
      color: 0x16a34a,
      url: "https://crypto.example.com/decisions/d1",
      fields: [
        { name: "Quantity", value: "0.0307", inline: true },
        { name: "Price", value: "$65,150.0", inline: true },
      ],
    })
  })

  it("does nothing without a webhook", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await alerts(null).success("Bought ETH/USD", "[paper] oversold bounce")
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("Alerts.send", () => {
  it("stores and streams every alert, and posts warnings with the level's icon and fields", async () => {
    const fetch = mockFetch(new Response(null, { status: 204 }))
    const { stored, emitted, alerts: a } = recording()
    await a.send("info", "Engine started", "all good")
    await a.send("warning", "Stop missed", "BTC/USD stop not filled", { path: "/holdings", fields: { Symbol: "BTC/USD", Note: "" } })

    expect(stored).toHaveLength(2)
    expect(emitted.map((e) => (e as [string, { title: string }])[1].title)).toEqual(["Engine started", "Stop missed"])
    expect(fetch).toHaveBeenCalledTimes(1) // info stays off Discord
    expect(fetchCall(fetch).body).toMatchObject({
      username: "TestBot",
      embeds: [{ title: "⚠️ Stop missed", color: 0xf59e0b, url: "https://bot.example.com/holdings", fields: [{ name: "Symbol", value: "BTC/USD", inline: true }] }],
    })
  })

  it("retries once after a rate limit or server error, and never throws", async () => {
    useFakeClock("2026-10-27T12:00:00Z")
    const fetch = mockFetch(new Response(null, { status: 429 }), new Response(null, { status: 204 }), new Response(null, { status: 503 }), new Response(null, { status: 503 }))
    const { alerts: a } = recording()
    await settle(a.send("error", "Order rejected", "insufficient funds"))
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(settle(a.send("critical", "Kill switch", "engaged"))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetchCall(fetch, 3).body.embeds[0].title).toBe("🛑 Kill switch")
  })
})
