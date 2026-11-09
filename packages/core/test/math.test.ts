import { describe, expect, it } from "vitest"
import { convictionScale, floorToStep, roundToStep } from "../src/math"

describe("rounding helpers", () => {
  it("floors to lot steps without float drift", () => {
    expect(floorToStep(0.123456789, 0.00000001)).toBe(0.12345678)
    expect(floorToStep(1.29999999999, 0.1)).toBe(1.3)
    expect(floorToStep(1.27, 0.1)).toBe(1.2)
    expect(floorToStep(5, 1)).toBe(5)
  })

  it("keeps an amount on a lot boundary there at large sizes", () => {
    // Float error grows with the number of steps; these used to lose a whole lot.
    expect(floorToStep(150270.4012, 0.00001)).toBe(150270.4012)
    expect(floorToStep(1.3359165, 0.00000001)).toBe(1.3359165)
    // A position's qty after four partial sells (19722.99017 in the wallet).
    expect(floorToStep(19722.990169999986, 0.00001)).toBe(19722.99017)
    expect(floorToStep(19722.990169, 0.00001)).toBe(19722.99016)
  })

  it("never rounds a very large amount up a lot", () => {
    // 3.1e13 steps: a slack of 1e-13 relative was 3 lots, and a stop-loss asked the wallet for
    // 311011883.14568 PEPE of the 311011883.14565 it held (2026-11-09).
    expect(floorToStep(311011883.14565, 0.00001)).toBe(311011883.14565)
    expect(floorToStep(311011883.14562, 0.00001)).toBe(311011883.14562)
    expect(floorToStep(311011883.145652, 0.00001)).toBe(311011883.14565)
    expect(floorToStep(9876543210.12345, 0.00001)).toBe(9876543210.12345)
  })

  it("rounds to price ticks", () => {
    expect(roundToStep(45285.24, 0.1)).toBe(45285.2)
    expect(roundToStep(0.5549, 0.001)).toBe(0.555)
  })
})

describe("conviction scale", () => {
  it("moves an entry's risk from 0.75x at the minimum conviction to 1.25x at the top, clamped", () => {
    expect(convictionScale(55, 55, 100)).toBe(0.75)
    expect(convictionScale(77.5, 55, 100)).toBe(1)
    expect(convictionScale(100, 55, 100)).toBe(1.25)
    expect(convictionScale(8, 6, 10)).toBe(1)
    expect(convictionScale(3, 6, 10)).toBe(0.75)
    expect(convictionScale(12, 6, 10)).toBe(1.25)
    expect(convictionScale(7, 10, 10)).toBe(1)
  })
})
