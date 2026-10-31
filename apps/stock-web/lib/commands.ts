import "server-only"
import { commandSchema } from "@mb/stock-core/commands"
import { applySettingsPatch, settingsSchema, type SettingsPatch } from "@mb/stock-core/settings"
import { signEngineRequest } from "@mb/stock-core/stream-token"
import { createCommands } from "@mb/web-kit/commands"
import { collections } from "./db"
import { env } from "./env"

/** Sends an owner command to the engine (@mb/web-kit/commands), validated against StockMarketBot's commands and settings. */
export const { submitCommand, getEngineCommand } = createCommands({
  collections,
  commandSchema,
  settingsSchema,
  applySettingsPatch: (base, patch) => applySettingsPatch(base, patch as SettingsPatch),
  engine: { streamUrl: env.engineStreamUrl, secret: env.streamTokenSecret, sign: signEngineRequest },
})
