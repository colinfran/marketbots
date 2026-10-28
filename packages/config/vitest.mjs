import { fileURLToPath } from "node:url"

/**
 * Vitest presets. Plain JavaScript, so a config file can import them without a TypeScript step.
 *
 *   export default defineConfig({ test: engineTest })
 *   export default defineConfig(webConfig(import.meta.url))
 */

/** Engines: one in-memory mongod for the whole run (test/setup/global.ts); every test file gets its own database. */
export const engineTest = {
  environment: "node",
  include: ["test/**/*.test.ts"],
  globalSetup: ["test/setup/global.ts"],
  setupFiles: ["test/setup/env.ts"],
  mockReset: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
  // Wall-clock waits on engine loops: generous, because the trading server runs the backfills and
  // the GPU beside the gate. A hung test still fails.
  testTimeout: 60_000,
  hookTimeout: 120_000,
}

/** Dashboards: the `@` alias points at the app's root, as in its tsconfig. */
export const webConfig = (appConfigUrl) => ({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", appConfigUrl)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    unstubEnvs: true,
  },
})
