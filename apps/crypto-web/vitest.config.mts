import { defineConfig } from "vitest/config"
import { webConfig } from "@mb/config/vitest.mjs"

export default defineConfig(webConfig(import.meta.url))
