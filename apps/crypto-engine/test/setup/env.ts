import { beforeEach, vi } from "vitest"

/**
 * Runs before every test file. Tests can never reach real services: any network call fails
 * loudly, and the Kraken CLI is always a fake exec function.
 */

process.env.STREAM_TOKEN_SECRET = "test-stream-secret-0123456789-abcdefghij"
delete process.env.AI_GATEWAY_API_KEY
delete process.env.DISCORD_WEBHOOK_URL

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected network request in a test: ${String(input)}`)
    }),
  )
})
