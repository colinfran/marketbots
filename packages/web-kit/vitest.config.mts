import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // "server-only" throws outside a React server build; the modules under test are plain functions.
  resolve: { alias: { "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
