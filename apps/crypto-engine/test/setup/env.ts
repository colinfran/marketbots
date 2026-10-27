import { setupTestEnv } from "@mb/engine-kit/testing/env"

/**
 * Runs before every test file. Tests can never reach real services (@mb/engine-kit/testing/env),
 * and the Kraken CLI is always a fake exec function.
 */

setupTestEnv()
