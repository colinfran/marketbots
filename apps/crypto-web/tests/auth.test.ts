import { describe, expect, it } from "vitest"
import { pct, price, qty, slugSymbol, symbolSlug, until, usd } from "../lib/format"
import { isOwnerEmail } from "../lib/owner"

describe("owner email", () => {
  const OWNER = "colin.franceschini@gmail.com"

  it("matches only the owner, ignoring case and spaces", () => {
    expect(isOwnerEmail("colin.franceschini@gmail.com", OWNER)).toBe(true)
    expect(isOwnerEmail("  Colin.Franceschini@Gmail.com ", OWNER)).toBe(true)
    expect(isOwnerEmail("colin.franceschini@gmail.co", OWNER)).toBe(false)
    expect(isOwnerEmail("someone@gmail.com", OWNER)).toBe(false)
    expect(isOwnerEmail(`${OWNER},someone@gmail.com`, OWNER)).toBe(false)
  })

  it("never matches a missing email or a blank owner", () => {
    expect(isOwnerEmail(undefined, OWNER)).toBe(false)
    expect(isOwnerEmail(null, OWNER)).toBe(false)
    expect(isOwnerEmail("", OWNER)).toBe(false)
    expect(isOwnerEmail("", "")).toBe(false)
    expect(isOwnerEmail(" ", " ")).toBe(false)
  })
})

describe("format", () => {
  it("formats money, percents, quantities and prices", () => {
    expect(usd(-1234.5)).toBe("−$1,234.50")
    expect(usd(12, { sign: true })).toBe("+$12.00")
    expect(pct(1.234)).toBe("+1.23%")
    expect(qty(0.0100)).toBe("0.01")
    expect(price(65012.4)).toBe("$65,012.40")
    expect(price(0.18341)).toBe("$0.1834")
    expect(slugSymbol(symbolSlug("BTC/USD"))).toBe("BTC/USD")
    expect(until(Date.now() + 5 * 60_000)).toBe("in 5m")
    expect(until(Date.now() - 1_000)).toBe("now")
  })
})
