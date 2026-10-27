import { afterEach, describe, expect, it, vi } from "vitest"
import { Alerts } from "../src/alerts"
import type { EventBus } from "../src/bus/event-bus"
import type { Collections } from "../src/db/mongo"
import { silentLogger } from "../src/log"

// success() never touches the database or the bus: purchases are already stored and streamed.
const alerts = (webhook: string | null) =>
  new Alerts({} as Pick<Collections, "notifications">, {} as EventBus, silentLogger, webhook, "https://crypto.example.com/")

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Alerts.success", () => {
  it("posts a green Discord embed with a dashboard link and fields, once per key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const a = alerts("https://discord.example.com/hook")
    const fields = { Quantity: 0.0307, Price: "$65,150.0", Stop: null }
    await a.success("Bought BTC/USD", "[paper] 4h breakout", { path: "/decisions/d1", key: "buy|o1", fields })
    await a.success("Bought BTC/USD", "[paper] 4h breakout", { path: "/decisions/d1", key: "buy|o1", fields })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe("https://discord.example.com/hook")
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
