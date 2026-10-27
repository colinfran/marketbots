import { describe, expect, it } from "vitest"
import { pct, price, qty, titleCase, tone, usd } from "@/lib/format"

const MINUS = "−"

describe("usd", () => {
  it("formats dollars with cents and thousands separators", () => {
    expect(usd(1234.5)).toBe("$1,234.50")
    expect(usd(0)).toBe("$0.00")
  })

  it("uses a true minus sign for negatives", () => {
    expect(usd(-5)).toBe(`${MINUS}$5.00`)
    expect(usd(-1234.567)).toBe(`${MINUS}$1,234.57`)
  })

  it("adds a plus sign only for positive values when asked", () => {
    expect(usd(12, { sign: true })).toBe("+$12.00")
    expect(usd(0, { sign: true })).toBe("$0.00")
    expect(usd(-12, { sign: true })).toBe(`${MINUS}$12.00`)
  })

  it("rounds to whole dollars when asked", () => {
    expect(usd(1234.56, { whole: true })).toBe("$1,235")
  })

  it("never shows a minus sign for values that round to zero", () => {
    expect(usd(-0.004)).toBe("$0.00")
    expect(usd(-0.004, { sign: true })).toBe("$0.00")
  })

  it.each([null, undefined, NaN, Infinity, -Infinity])("renders %s as a dash", (value) => {
    expect(usd(value)).toBe("—")
  })
})

describe("pct", () => {
  it("signs by default", () => {
    expect(pct(1.234)).toBe("+1.23%")
    expect(pct(-1.235)).toMatch(new RegExp(`^${MINUS}1\\.2[34]%$`))
    expect(pct(0)).toBe("0.00%")
  })

  it("respects sign and digits options", () => {
    expect(pct(1.234, { sign: false })).toBe("1.23%")
    expect(pct(1.25, { digits: 1 })).toMatch(/^\+1\.[23]%$/)
    expect(pct(-3, { digits: 0 })).toBe(`${MINUS}3%`)
  })

  it("never shows a sign for values that round to zero", () => {
    expect(pct(-0.001)).toBe("0.00%")
    expect(pct(0.001)).toBe("0.00%")
  })

  it.each([null, undefined, NaN, Infinity])("renders %s as a dash", (value) => {
    expect(pct(value)).toBe("—")
  })
})

describe("qty", () => {
  it("shows whole shares as integers and fractional shares with 4 decimals", () => {
    expect(qty(5)).toBe("5")
    expect(qty(0)).toBe("0")
    expect(qty(1.5)).toBe("1.5000")
    expect(qty(0.123456)).toBe("0.1235")
  })
})

describe("price", () => {
  it("formats with two decimals and no separators", () => {
    expect(price(12.3)).toBe("$12.30")
    expect(price(1234.567)).toBe("$1234.57")
  })

  it.each([null, undefined, NaN])("renders %s as a dash", (value) => {
    expect(price(value)).toBe("—")
  })
})

describe("tone", () => {
  it("colors gains and losses", () => {
    expect(tone(0.01)).toBe("text-gain")
    expect(tone(-0.01)).toBe("text-loss")
  })

  it("treats zero, sub-cent values and missing values as neutral", () => {
    for (const value of [0, 0.004, -0.004, null, undefined, NaN]) expect(tone(value)).toBe("text-muted-foreground")
  })
})

describe("titleCase", () => {
  it("replaces underscores and capitalizes words", () => {
    expect(titleCase("adjust_exits")).toBe("Adjust Exits")
    expect(titleCase("very_bullish")).toBe("Very Bullish")
    expect(titleCase("hold")).toBe("Hold")
  })
})
