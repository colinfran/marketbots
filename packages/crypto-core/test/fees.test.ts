import { describe, expect, it } from "vitest"
import { krakenFee } from "../src/fees"

describe("krakenFee", () => {
  it("applies a bps rate to the notional", () => {
    expect(krakenFee(1_000, 40)).toBe(4)
    expect(krakenFee(250, 26)).toBeCloseTo(0.65)
  })
})
