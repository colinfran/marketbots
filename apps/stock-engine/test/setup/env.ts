import { setupTestEnv } from "@mb/engine-kit/testing/env"
import { beforeEach } from "vitest"
import { clearCalendarCache } from "../../src/bot/session"

/**
 * Runs before every test file. Tests can never reach real services (@mb/engine-kit/testing/env),
 * and Alpaca is always the in-memory fake broker passed through the context.
 */

beforeEach(() => {
  clearCalendarCache()
})

setupTestEnv()
