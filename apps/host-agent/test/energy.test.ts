import { describe, expect, it } from "vitest"
import { EnergyMinutes } from "../src/energy"

const M = 60_000
const H = 60 * M
const D = 24 * H
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)

/** A minute sample `ago` ms before NOW. */
const minute = (ago: number, wh: number | null, outlet: string | null = "o", covered = M) => ({ res: "1m", t: new Date(NOW - ago), wh, covered_ms: covered, outlet_id: outlet })

const WINDOWS = { today: 12 * H, last_24h: D, last_7d: 7 * D, last_30d: 30 * D }

describe("EnergyMinutes", () => {
  it("sums each window's minutes, a minute with no energy counting its coverage only", () => {
    const kept = new EnergyMinutes("o", NOW)
    kept.load([minute(H, 10), minute(13 * H, 20), minute(2 * D, 30), minute(10 * D, 40), minute(5 * M, null, "o", 30_000)])
    expect(kept.totals(NOW, WINDOWS)).toEqual({
      today: { wh: 10, ms: M + 30_000 },
      last_24h: { wh: 30, ms: 2 * M + 30_000 },
      last_7d: { wh: 60, ms: 3 * M + 30_000 },
      last_30d: { wh: 100, ms: 4 * M + 30_000 },
    })
  })

  it("counts a minute starting exactly at a window's edge, and drops minutes past 30 days", () => {
    const kept = new EnergyMinutes("o", NOW)
    kept.load([minute(D, 5), minute(30 * D + M, 7)])
    expect(kept.totals(NOW, WINDOWS).last_24h).toEqual({ wh: 5, ms: M })
    // A day later the 24-hour minute is past 24 h, and the old one is gone for good.
    expect(kept.totals(NOW + M, { last_24h: D, last_30d: 31 * D })).toEqual({ last_24h: { wh: 0, ms: 0 }, last_30d: { wh: 5, ms: M } })
  })

  it("keeps the minutes it is given: its outlet's, replacing a rewritten bucket, and only new ones from an import", () => {
    const kept = new EnergyMinutes("o", NOW)
    kept.load([minute(H, 10)])
    kept.put(minute(H, 12))
    kept.put(minute(2 * H, 3, "other"))
    kept.put({ ...minute(3 * H, 3), res: "raw" })
    kept.put(minute(4 * H, 8), true)
    kept.put(minute(4 * H, 99), true)
    expect(kept.totals(NOW, { last_24h: D }).last_24h).toEqual({ wh: 20, ms: 2 * M })
    // The same bucket rewritten for another outlet no longer counts.
    kept.put(minute(H, 12, "other"))
    expect(kept.totals(NOW, { last_24h: D }).last_24h).toEqual({ wh: 8, ms: M })
  })

  it("keeps a minute written while the database read ran over the read's older copy", () => {
    const kept = new EnergyMinutes("o", NOW)
    kept.put(minute(M, 2))
    kept.load([minute(M, 1), minute(2 * M, 1)])
    expect(kept.totals(NOW, { last_24h: D }).last_24h).toEqual({ wh: 3, ms: 2 * M })
  })
})
