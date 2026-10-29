import { describe, expect, it } from "vitest"
import { AttentionQueue, OBSERVATION_TTL_MS } from "../src/queue"
import { obs } from "./helpers"

const setup = (cooldownMinutes = 5) => {
  let t = Date.parse("2026-10-28T14:00:00Z")
  const q = new AttentionQueue(() => cooldownMinutes * 60_000, () => t)
  return { q, advance: (ms: number) => (t += ms), at: () => new Date(t) }
}

describe("attention queue", () => {
  it("coalesces a burst about one subject into one wake-up after its quiet time", () => {
    const { q, advance, at } = setup()
    q.add(obs({ subject: "SOL/USD", priority: 1, salience: 60, at: at() }))
    advance(3_000)
    q.add(obs({ subject: "SOL/USD", priority: 1, salience: 75, at: at() }))
    advance(3_000)
    expect(q.take()).toBeNull()
    advance(2_500)
    const wake = q.take()!
    expect(wake.subject).toBe("SOL/USD")
    expect(wake.observations).toHaveLength(2)
    expect(wake.salience).toBe(75)
    expect(q.size).toBe(0)
  })

  it("wakes at most 20 s after the first observation, however long the burst", () => {
    const { q, advance, at } = setup()
    for (let i = 0; i < 6; i++) {
      q.add(obs({ subject: "BTC/USD", priority: 2, at: at() }))
      advance(4_000)
    }
    expect(q.take()?.observations).toHaveLength(6)
  })

  it("serves the highest priority first, then salience", () => {
    const { q, advance, at } = setup()
    q.add(obs({ subject: "ETH/USD", priority: 2, salience: 90, at: at() }))
    q.add(obs({ subject: "SOL/USD", priority: 1, salience: 40, at: at() }))
    q.add(obs({ subject: "ADA/USD", priority: 1, salience: 70, at: at() }))
    advance(11_000)
    expect([q.take()!.subject, q.take()!.subject, q.take()!.subject]).toEqual(["ADA/USD", "SOL/USD", "ETH/USD"])
  })

  it("keeps a subject in its cooldown unless its salience jumps, a P0 or an urgent observation arrives", () => {
    const { q, advance, at } = setup()
    q.add(obs({ subject: "SOL/USD", priority: 2, salience: 50, at: at() }))
    advance(11_000)
    expect(q.take()).not.toBeNull()
    q.add(obs({ subject: "SOL/USD", priority: 2, salience: 60, at: at() }))
    advance(11_000)
    expect(q.take()).toBeNull()
    q.add(obs({ subject: "SOL/USD", priority: 2, salience: 66, at: at() }))
    advance(11_000)
    expect(q.take()?.salience).toBe(66)

    q.add(obs({ subject: "SOL/USD", priority: 2, salience: 10, at: at() }))
    advance(11_000)
    expect(q.take()).toBeNull()
    q.add(obs({ subject: "SOL/USD", priority: 2, salience: 10, urgent: true, at: at() }))
    advance(11_000)
    expect(q.take()?.observations).toHaveLength(2)

    q.add(obs({ subject: "SOL/USD", priority: 0, salience: 10, at: at() }))
    advance(2_500)
    expect(q.take()?.priority).toBe(0)
  })

  it("lets an observation wait out the cooldown instead of dropping it", () => {
    const { q, advance, at } = setup(5)
    q.add(obs({ subject: "SOL/USD", at: at() }))
    advance(11_000)
    q.take()
    q.add(obs({ subject: "SOL/USD", at: at() }))
    advance(4 * 60_000)
    expect(q.take()).toBeNull()
    advance(60_000)
    expect(q.take()?.subject).toBe("SOL/USD")
  })

  it("drops observations nobody served within 30 minutes", () => {
    const { q, advance, at } = setup()
    q.add(obs({ subject: "SOL/USD", at: at() }))
    advance(OBSERVATION_TTL_MS + 1)
    expect(q.take()).toBeNull()
    expect(q.size).toBe(0)
  })

  it("reports a ready P0 for preemption and ignores duplicate observation ids", () => {
    const { q, advance, at } = setup()
    const o = obs({ subject: "BTC/USD", priority: 0, at: at() })
    q.add(o)
    q.add(o)
    expect(q.urgentReady()).toBe(false)
    advance(2_000)
    expect(q.urgentReady()).toBe(true)
    expect(q.pending()).toEqual([{ subject: "BTC/USD", priority: 0, salience: 50, observations: 1 }])
  })
})
