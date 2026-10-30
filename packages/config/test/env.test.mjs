import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { devEnv, scopeEnv } from "../env.mjs"

describe("scopeEnv", () => {
  const vars = {
    MONGODB_URI: "mongodb://shared",
    LOG_LEVEL: "info",
    CRYPTO_MONGODB_DB_NAME: "cryptomarketbot",
    CRYPTO_LOG_LEVEL: "debug",
    STOCK_MONGODB_DB_NAME: "stockmarketbot",
    STOCK_ALPACA_SECRET_KEY: "secret",
    HISTORY_CRYPTO_PASSWORD: "pw",
  }

  it("keeps shared names, strips the bot's prefix and leaves the other bot out", () => {
    expect(scopeEnv(vars, "crypto")).toEqual({
      MONGODB_URI: "mongodb://shared",
      LOG_LEVEL: "debug",
      MONGODB_DB_NAME: "cryptomarketbot",
      HISTORY_CRYPTO_PASSWORD: "pw",
    })
    expect(scopeEnv(vars, "stock")).toEqual({
      MONGODB_URI: "mongodb://shared",
      LOG_LEVEL: "info",
      MONGODB_DB_NAME: "stockmarketbot",
      ALPACA_SECRET_KEY: "secret",
      HISTORY_CRYPTO_PASSWORD: "pw",
    })
  })

  it("refuses an unknown bot", () => {
    expect(() => scopeEnv(vars, "forex")).toThrow('Unknown bot "forex"')
  })
})

describe("devEnv", () => {
  let root
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))

  it("reads .env, then .env.local, whose values win", () => {
    root = mkdtempSync(join(tmpdir(), "mb-env-"))
    writeFileSync(join(root, ".env"), "MONGODB_URI=mongodb://live\nCRYPTO_MONGODB_DB_NAME=cryptomarketbot\nCRYPTO_DISCORD_WEBHOOK_URL='https://discord/x'\n")
    writeFileSync(join(root, ".env.local"), "CRYPTO_MONGODB_DB_NAME=cryptomarketbot_dev\nCRYPTO_DISCORD_WEBHOOK_URL=\n")
    expect(devEnv(root, "crypto")).toEqual({ MONGODB_URI: "mongodb://live", MONGODB_DB_NAME: "cryptomarketbot_dev", DISCORD_WEBHOOK_URL: "" })
  })

  it("is empty without either file", () => {
    root = mkdtempSync(join(tmpdir(), "mb-env-"))
    expect(devEnv(root, "stock")).toEqual({})
  })
})
