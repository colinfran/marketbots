import type { TradeUpdate } from "@mb/stock-core/alpaca"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { MarketStream } from "../../src/alpaca/market-stream"
import { TradeStream } from "../../src/alpaca/trade-stream"
import { silentLogger } from "../../src/log"
import { alpacaOrder } from "../helpers/factories"

/** A local WebSocket server that speaks enough of Alpaca's protocols to test the clients. */
const server = (onConnection: (ws: WebSocket) => void) =>
  new Promise<{ wss: WebSocketServer; url: string }>((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address() as { port: number }
      resolve({ wss, url: `ws://127.0.0.1:${address.port}` })
    })
    wss.on("connection", onConnection)
  })

const until = async (check: () => boolean, ms = 3_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const creds = { keyId: "key-id", secret: "secret-key" }
let cleanup: (() => void)[] = []

afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

describe("TradeStream", () => {
  it("authenticates, listens to trade_updates and decodes binary frames", async () => {
    const received: unknown[] = []
    const { wss, url } = await server((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        received.push(msg)
        // The paper endpoint answers in binary frames.
        if (msg.action === "auth") ws.send(Buffer.from(JSON.stringify({ stream: "authorization", data: { status: "authorized", action: "authenticate" } })))
        if (msg.action === "listen") {
          ws.send(Buffer.from(JSON.stringify({ stream: "listening", data: { streams: ["trade_updates"] } })))
          ws.send(Buffer.from(JSON.stringify({ stream: "trade_updates", data: { event: "fill", order: alpacaOrder({ id: "o1" }), price: "100", qty: "10", position_qty: "10" } })))
        }
      })
    })
    const updates: TradeUpdate[] = []
    const states: boolean[] = []
    const stream = new TradeStream(creds, silentLogger, { onUpdate: (u) => updates.push(u), onState: (c) => states.push(c) }, url)
    cleanup.push(() => stream.stop(), () => wss.close())
    stream.start()
    await until(() => updates.length === 1)
    expect(received).toEqual([
      { action: "auth", key: "key-id", secret: "secret-key" },
      { action: "listen", data: { streams: ["trade_updates"] } },
    ])
    expect(updates[0]).toMatchObject({ event: "fill", position_qty: "10", order: { id: "o1" } })
    expect(stream.health.state).toBe("connected")
    expect(states).toEqual([true])
  })

  it("reports a rejected login and stays disconnected", async () => {
    const { wss, url } = await server((ws) => ws.on("message", () => ws.send(JSON.stringify({ stream: "authorization", data: { status: "unauthorized" } }))))
    const stream = new TradeStream(creds, silentLogger, { onUpdate: () => undefined }, url)
    cleanup.push(() => stream.stop(), () => wss.close())
    stream.start()
    await until(() => stream.health.last_error !== null)
    expect(stream.health.last_error).toMatch(/authorization failed/)
    expect(stream.health.state).not.toBe("connected")
  })
})

describe("MarketStream", () => {
  it("authenticates, subscribes to trades and quotes, and diffs later changes", async () => {
    const received: Record<string, unknown>[] = []
    let socket: WebSocket | null = null
    const { wss, url } = await server((ws) => {
      socket = ws
      ws.send(JSON.stringify([{ T: "success", msg: "connected" }]))
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        received.push(msg)
        if (msg.action === "auth") ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }]))
        if (msg.action === "subscribe" || msg.action === "unsubscribe") ws.send(JSON.stringify([{ T: "subscription", trades: msg.action === "subscribe" ? msg.trades : [], quotes: [] }]))
      })
    })
    const trades: [string, number][] = []
    const quotes: [string, number, number][] = []
    const stream = new MarketStream(creds, silentLogger, { onTrade: (s, p) => trades.push([s, p]), onQuote: (s, b, a) => quotes.push([s, b, a]) }, url)
    cleanup.push(() => stream.stop(), () => wss.close())
    stream.setSymbols(["aapl", "SPY"])
    stream.start()
    await until(() => stream.symbols.length === 2)
    expect(received.slice(0, 2)).toEqual([
      { action: "auth", key: "key-id", secret: "secret-key" },
      { action: "subscribe", trades: ["AAPL", "SPY"], quotes: ["AAPL", "SPY"] },
    ])
    socket!.send(JSON.stringify([{ T: "t", S: "AAPL", p: 230.5, s: 100, t: "2026-10-26T15:00:00Z" }, { T: "q", S: "SPY", bp: 580, ap: 580.02, t: "2026-10-26T15:00:00Z" }]))
    await until(() => trades.length === 1 && quotes.length === 1)
    expect(trades).toEqual([["AAPL", 230.5]])
    expect(quotes).toEqual([["SPY", 580, 580.02]])

    stream.setSymbols(["SPY", "NVDA"])
    await until(() => received.length === 4)
    expect(received.slice(2)).toEqual([
      { action: "unsubscribe", trades: ["AAPL"], quotes: ["AAPL"] },
      { action: "subscribe", trades: ["NVDA"], quotes: ["NVDA"] },
    ])
  })

  it("records Alpaca's errors (e.g. the free plan's connection limit)", async () => {
    const { wss, url } = await server((ws) => ws.send(JSON.stringify([{ T: "error", code: 406, msg: "connection limit exceeded" }])))
    const stream = new MarketStream(creds, silentLogger, { onTrade: () => undefined, onQuote: () => undefined }, url)
    cleanup.push(() => stream.stop(), () => wss.close())
    stream.start()
    await until(() => stream.health.last_error !== null)
    expect(stream.health.last_error).toBe("406 connection limit exceeded")
  })
})
