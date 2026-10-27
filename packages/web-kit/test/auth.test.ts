import { createHash } from "node:crypto"
import { emailOTP } from "better-auth/plugins"
import { describe, expect, it } from "vitest"
import { hashIp, UNUSED_OTP_PATHS } from "../src/auth"

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

describe("email OTP routes", () => {
  const routed = Object.values(emailOTP({ sendVerificationOTP: async () => {} }).endpoints)
    .map((endpoint) => endpoint.path)
    .filter((path): path is string => typeof path === "string")

  it("leaves only asking for a sign-in code and signing in with it", () => {
    expect(routed.filter((path) => !UNUSED_OTP_PATHS.includes(path)).sort()).toEqual(["/email-otp/send-verification-otp", "/sign-in/email-otp"])
  })

  it("disables only routes that exist", () => {
    expect(UNUSED_OTP_PATHS.filter((path) => !routed.includes(path))).toEqual([])
  })
})
