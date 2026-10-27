import { describe, expect, it } from "vitest"
import { isOwnerEmail } from "../src/owner"

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
