import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hashIp } from "../src/auth"

/** The hash each dashboard stored before the auth factory was shared (the login rate-limit keys). */
const before = (salt: string, value: string) => createHash("sha256").update(`${salt}${value}`).digest("hex").slice(0, 32)

describe("hashIp", () => {
  it("keeps each bot's existing rate-limit keys", () => {
    expect(hashIp("cmb-ip.", "203.0.113.7")).toBe(before("cmb-ip.", "203.0.113.7"))
    expect(hashIp("smb-ip.", "203.0.113.7")).toBe(before("smb-ip.", "203.0.113.7"))
    expect(hashIp("cmb-ip.", "203.0.113.7")).toHaveLength(32)
  })

  it("never gives the same key in both bots", () => {
    expect(hashIp("cmb-ip.", "203.0.113.7")).not.toBe(hashIp("smb-ip.", "203.0.113.7"))
  })
})
