import type { UserConfig } from "vitest/config"

export declare const engineTest: NonNullable<UserConfig["test"]>
export declare const webConfig: (appConfigUrl: string) => UserConfig
