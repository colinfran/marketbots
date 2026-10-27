import { describe, expect, it } from "vitest"
import { krakenFee } from "../src/fees"
import { floorToStep, roundToStep } from "../src/math"

describe("krakenFee", () => {
  it("applies a bps rate to the notional", () => {
    expect(krakenFee(1_000, 40)).toBe(4)
    expect(krakenFee(250, 26)).toBeCloseTo(0.65)
  })
})

describe("rounding helpers", () => {
  it("floors to lot steps without float drift", () => {
    expect(floorToStep(0.123456789, 0.00000001)).toBe(0.12345678)
    expect(floorToStep(1.29999999999, 0.1)).toBe(1.3)
    expect(floorToStep(1.27, 0.1)).toBe(1.2)
    expect(floorToStep(5, 1)).toBe(5)
  })

  it("rounds to price ticks", () => {
    expect(roundToStep(45285.24, 0.1)).toBe(45285.2)
    expect(roundToStep(0.5549, 0.001)).toBe(0.555)
  })
})
