import { describe, expect, it } from "vitest"
import { z } from "zod"
import { envFields, optional, parseEnv } from "../src/env"

const base = envFields({ dbName: "testbot", streamPort: 8799 })
const schema = z.object({
  MONGODB_URI: base.MONGODB_URI,
  MONGODB_DB_NAME: base.MONGODB_DB_NAME,
  STREAM_TOKEN_SECRET: base.STREAM_TOKEN_SECRET,
  STREAM_PORT: base.STREAM_PORT,
  STREAM_ALLOWED_ORIGINS: base.STREAM_ALLOWED_ORIGINS,
  STREAM_TRUST_PROXY: base.STREAM_TRUST_PROXY,
  OWN_KEY: optional,
})

describe("parseEnv", () => {
  it("trims every value and applies the bot's defaults", () => {
    const env = parseEnv(schema, { MONGODB_URI: "mongodb://db\r", STREAM_TOKEN_SECRET: `${"x".repeat(40)}\r`, STREAM_ALLOWED_ORIGINS: "https://a.example/, https://b.example", STREAM_TRUST_PROXY: "Yes", OWN_KEY: "  " })
    expect(env).toEqual({
      MONGODB_URI: "mongodb://db",
      MONGODB_DB_NAME: "testbot",
      STREAM_TOKEN_SECRET: "x".repeat(40),
      STREAM_PORT: 8799,
      STREAM_ALLOWED_ORIGINS: ["https://a.example", "https://b.example"],
      STREAM_TRUST_PROXY: true,
      OWN_KEY: null,
    })
  })

  it("reads an empty value as unset, so the default applies", () => {
    const env = parseEnv(schema, { MONGODB_URI: "mongodb://db", MONGODB_DB_NAME: "", STREAM_TOKEN_SECRET: "x".repeat(40), STREAM_PORT: " ", STREAM_TRUST_PROXY: "" })
    expect(env).toMatchObject({ MONGODB_DB_NAME: "testbot", STREAM_PORT: 8799, STREAM_TRUST_PROXY: false })
  })

  it("lists every problem in one readable error, in the schema's order", () => {
    expect(() => parseEnv(schema, { STREAM_TOKEN_SECRET: "short" })).toThrow(
      "Invalid engine environment:\n  - MONGODB_URI: Invalid input: expected string, received undefined\n  - STREAM_TOKEN_SECRET: STREAM_TOKEN_SECRET must be at least 32 characters",
    )
  })
})
