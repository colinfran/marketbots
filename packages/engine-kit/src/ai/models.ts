/** Model ids the runner accepts. */

export const LOCAL_PREFIX = "local/"

/** Models on the local model server: "local/<its alias>", e.g. local/qwen3.6-35b-a3b-q2. They cost nothing. */
export const isLocalModel = (model: string) => model.startsWith(LOCAL_PREFIX)
