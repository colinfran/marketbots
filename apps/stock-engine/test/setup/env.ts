import { beforeEach, vi } from "vitest"
import { clearCalendarCache } from "../../src/bot/session"

/**
 * Runs before every test file. Tests can never reach real services: any network call fails
 * loudly, and Alpaca is always the in-memory fake broker passed through the context.
 */

process.env.STREAM_TOKEN_SECRET = "test-stream-secret-0123456789-abcdefghij"
delete process.env.AI_GATEWAY_API_KEY
delete process.env.DISCORD_WEBHOOK_URL

beforeEach(() => {
  clearCalendarCache()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected network request in a test: ${String(input)}`)
    }),
  )
})
