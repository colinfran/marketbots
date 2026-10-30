import { defineConfig } from "vitest/config"

/** Pure tests: parsers, the energy maths, the minute samples, the fan controller against a fake board. No database. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
  },
})
