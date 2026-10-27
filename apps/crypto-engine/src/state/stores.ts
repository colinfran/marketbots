import { applySettingsPatch, DEFAULT_SETTINGS, settingsSchema, type Settings, type SettingsPatch } from "@mb/crypto-core/settings"
import type { Logger } from "@mb/engine-kit/log"
import { SettingsStore as SettingsStoreOf, type SettingsView as SettingsViewOf } from "@mb/engine-kit/state/stores"
import type { Collections } from "../db/mongo"
import type { Env } from "../env"

export { EngineStateStore } from "@mb/engine-kit/state/stores"

/** What trading code needs from settings: the current values and their version. */
export type SettingsView = SettingsViewOf<Settings>

/** Crypto's settings in the shared store (@mb/engine-kit/state/stores). */
export type SettingsStore = SettingsStoreOf<Settings, SettingsPatch>

/**
 * Loads crypto's settings. On first boot they are seeded from the defaults, with the research and
 * decision models the env sets (the dashboard owns them afterwards).
 */
export const loadSettings = (col: Pick<Collections, "settings" | "audit">, env: Pick<Env, "GROK_RESEARCH_MODEL" | "GROK_DECISION_MODEL">, log: Logger): Promise<SettingsStore> =>
  SettingsStoreOf.load(
    col,
    {
      schema: settingsSchema,
      defaults: DEFAULT_SETTINGS,
      applyPatch: applySettingsPatch,
      seed: (defaults) => ({
        ...defaults,
        ai: {
          ...defaults.ai,
          models: {
            ...defaults.ai.models,
            research: env.GROK_RESEARCH_MODEL ?? defaults.ai.models.research,
            decision: env.GROK_DECISION_MODEL ?? defaults.ai.models.decision,
          },
        },
      }),
    },
    log,
  )
