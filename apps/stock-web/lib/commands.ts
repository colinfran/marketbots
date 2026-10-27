import "server-only"
import { commandSchema } from "@mb/stock-core/commands"
import { applySettingsPatch, settingsSchema, type SettingsPatch } from "@mb/stock-core/settings"
import { createCommands } from "@mb/web-kit/commands"
import { collections } from "./db"

/** Queues an owner command for the engine (@mb/web-kit/commands), validated against StockMarketBot's commands and settings. */
export const { submitCommand } = createCommands({ collections, commandSchema, settingsSchema, applySettingsPatch: (base, patch) => applySettingsPatch(base, patch as SettingsPatch) })
