import type { Logger } from "@mb/engine-kit/log"
import { SettingsStore as SettingsStoreOf, type SettingsView as SettingsViewOf } from "@mb/engine-kit/state/stores"
import { applySettingsPatch, DEFAULT_SETTINGS, settingsSchema, upgradeStockSettings, type Settings, type SettingsPatch } from "@mb/stock-core/settings"
import type { Collections } from "../db/mongo"
import type { Env } from "../env"

export { EngineStateStore } from "@mb/engine-kit/state/stores"

/** What trading code needs from settings: the current values and their version. */
export type SettingsView = SettingsViewOf<Settings>

/** Stock's settings in the shared store (@mb/engine-kit/state/stores). */
export type SettingsStore = SettingsStoreOf<Settings, SettingsPatch>

/**
 * Loads stock's settings. On first boot they are seeded from the defaults, with the starting
 * capital the env sets (the dashboard owns them afterwards).
 */
export const loadSettings = (
  col: Pick<Collections, "settings" | "audit">,
  env: Pick<Env, "STARTING_CAPITAL">,
  log: Logger,
): Promise<SettingsStore> =>
  SettingsStoreOf.load(
    col,
    {
      schema: settingsSchema,
      defaults: DEFAULT_SETTINGS,
      applyPatch: applySettingsPatch,
      seed: (defaults) => ({
        ...defaults,
        account: { starting_capital: env.STARTING_CAPITAL ?? defaults.account.starting_capital },
      }),
      upgrade: upgradeStockSettings,
    },
    log,
  )
