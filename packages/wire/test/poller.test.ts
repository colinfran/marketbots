import { silentLogger } from "@mb/engine-kit/log"
import { HttpError } from "@mb/engine-kit/util/http"
import { describe, expect, it, vi } from "vitest"
import { PollingSource } from "../src/poller"
import type { RawItem, SourceContext, SourceSpec } from "../src/types"

const NOW = new Date("2026-10-27T12:00:00Z")

describe("polling sources", () => {
  const ctx = { log: silentLogger, now: () => NOW } as SourceContext
  const s: SourceSpec = { id: "t", kind: "rss", interval_s: 60, tier: 2, default_enabled: true }

  it("marks the first poll as backfill, skips 304s, and degrades after repeated 403/429", async () => {
    const poll = vi.fn<() => Promise<RawItem[] | null>>()
    poll.mockResolvedValueOnce([{ title: "a" }]).mockResolvedValueOnce(null).mockResolvedValueOnce([{ title: "b" }])
    const states: string[] = []
    const src = new PollingSource(s, ctx, poll, (_id, st) => states.push(st))
    const emit = vi.fn(async (_items: RawItem[], _opts?: { backfill?: boolean }) => undefined)
    await src.tick(emit)
    await src.tick(emit)
    await src.tick(emit)
    expect(emit.mock.calls.map((c) => c[1])).toEqual([{ backfill: true }, { backfill: false }])
    poll.mockRejectedValue(new HttpError(429, "slow down", ""))
    for (let i = 0; i < 3; i++) await src.tick(emit)
    expect(src.health()).toMatchObject({ state: "degraded", last_error: expect.stringContaining("slow down") })
    expect(states).toEqual(["ok", "degraded"])
  })
})
