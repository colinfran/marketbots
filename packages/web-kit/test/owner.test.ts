import { describe, expect, it } from "vitest"
import { isOwnerEmail } from "../src/owner"

describe("owner email", () => {
  const OWNER = "owner.name@example.com"

  it("matches only the owner, ignoring case and spaces", () => {
    expect(isOwnerEmail("owner.name@example.com", OWNER)).toBe(true)
    expect(isOwnerEmail("  Owner.Name@Example.com ", OWNER)).toBe(true)
    expect(isOwnerEmail("owner.name@example.co", OWNER)).toBe(false)
    expect(isOwnerEmail("someone@example.com", OWNER)).toBe(false)
    expect(isOwnerEmail(`${OWNER},someone@example.com`, OWNER)).toBe(false)
  })

  it("never matches a missing email or a blank owner", () => {
    expect(isOwnerEmail(undefined, OWNER)).toBe(false)
    expect(isOwnerEmail(null, OWNER)).toBe(false)
    expect(isOwnerEmail("", OWNER)).toBe(false)
    expect(isOwnerEmail("", "")).toBe(false)
    expect(isOwnerEmail(" ", " ")).toBe(false)
  })

  it("matches nobody when OWNER_EMAIL isn't set", () => {
    expect(isOwnerEmail(OWNER, null)).toBe(false)
    expect(isOwnerEmail(OWNER, undefined)).toBe(false)
  })
})
