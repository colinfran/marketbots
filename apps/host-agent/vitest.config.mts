import { defineConfig } from "vitest/config"

/** No outside services: parsers, the energy maths, the minute samples, the fan controller against a fake board, the store on SQLite (in memory or a temp file) and the API on a free local port. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
  },
})
