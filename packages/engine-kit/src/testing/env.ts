import { beforeEach, vi } from "vitest"

/** The stream token secret every engine test runs with. */
export const TEST_STREAM_SECRET = "test-stream-secret-0123456789-abcdefghij"

/**
 * The per-file setup of an engine's tests (each package's `test/setup/env.ts` calls it). Tests can
 * never reach real services: any network call fails loudly, and the AI gateway and Discord are
 * never configured.
 */
export const setupTestEnv = () => {
  process.env.STREAM_TOKEN_SECRET = TEST_STREAM_SECRET
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
}
