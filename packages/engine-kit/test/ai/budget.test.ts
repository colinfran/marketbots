import { describe, expect, it } from "vitest"
import { gatewayCost } from "../../src/ai/budget"

describe("gatewayCost", () => {
  it("reads string or number costs and ignores junk", () => {
    expect(gatewayCost({ gateway: { cost: "0.5" } })).toBe(0.5)
    expect(gatewayCost({ gateway: { totalCost: 0.25 } })).toBe(0.25)
    expect(gatewayCost({ gateway: { cost: "abc" } })).toBeNull()
    expect(gatewayCost(undefined)).toBeNull()
  })

  it("uses marketCost when the gateway bills nothing (own provider key)", () => {
    expect(gatewayCost({ gateway: { cost: "0", marketCost: "0.00030935" } })).toBe(0.00030935)
  })
})
