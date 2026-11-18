import { getEventListeners } from "node:events"
import { describe, expect, it } from "vitest"
import { sleep } from "../src/util/async"

describe("sleep", () => {
  it("leaves no listener on a long-lived signal once the timer fires", async () => {
    const engine = new AbortController()
    for (let i = 0; i < 50; i++) await sleep(0, engine.signal)
    expect(getEventListeners(engine.signal, "abort")).toHaveLength(0)
  })

  it("still wakes up early when the signal aborts", async () => {
    const stop = new AbortController()
    const started = Date.now()
    const nap = sleep(60_000, stop.signal)
    stop.abort()
    await nap
    expect(Date.now() - started).toBeLessThan(1_000)
    // Already aborted: resolves at once, without a timer or a listener.
    await sleep(60_000, stop.signal)
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0)
  })
})
