import "server-only"
import { commandSchema } from "@mb/crypto-core/commands"
import { applySettingsPatch, settingsSchema, type SettingsPatch } from "@mb/crypto-core/settings"
import { signEngineRequest } from "@mb/crypto-core/stream-token"
import { createCommands } from "@mb/web-kit/commands"
import { collections } from "./db"
import { env } from "./env"

/** Sends an owner command to the engine (@mb/web-kit/commands), validated against CryptoMarketBot's commands and settings. */
export const { submitCommand, getEngineCommand } = createCommands({
  collections,
  commandSchema,
  settingsSchema,
  applySettingsPatch: (base, patch) => applySettingsPatch(base, patch as SettingsPatch),
  engine: { streamUrl: env.engineStreamUrl, secret: env.streamTokenSecret, sign: signEngineRequest },
})
