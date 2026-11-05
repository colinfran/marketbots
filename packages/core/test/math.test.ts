import { describe, expect, it } from "vitest"
import { floorToStep, roundToStep } from "../src/math"

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

  it("rounds to price ticks", () => {
    expect(roundToStep(45285.24, 0.1)).toBe(45285.2)
    expect(roundToStep(0.5549, 0.001)).toBe(0.555)
  })
})
