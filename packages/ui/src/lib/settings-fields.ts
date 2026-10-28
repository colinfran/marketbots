/**
 * The Admin page's field definitions and the pure parts of the settings form: how a field's input
 * becomes a settings value, and what a dropdown offers.
 */

export type SelectOption = { value: string; label: string }

/**
 * list: comma-separated tickers (uppercased). idlist: comma-separated ids. lines: one entry per line,
 * for entries that contain commas. select: a dropdown of `options`; `none` adds a first choice, with
 * that label, that stores null.
 */
export type SettingsField = {
  path: string
  label: string
  kind: "number" | "boolean" | "text" | "list" | "idlist" | "lines" | "select"
  options?: (string | SelectOption)[]
  none?: string
  step?: number
}

export type SettingsSection = { title: string; fields: SettingsField[] }

export const toInput = (v: unknown, separator = ", ") => (Array.isArray(v) ? v.join(separator) : v === null || v === undefined ? "" : String(v))

/** A field's input as the value the settings patch carries. */
export const parseField = (f: SettingsField, raw: unknown): unknown => {
  if (f.kind === "number") return Number(raw)
  if (f.kind === "list") return String(raw).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (f.kind === "idlist") return String(raw).split(",").map((s) => s.trim()).filter(Boolean)
  if (f.kind === "lines") return (Array.isArray(raw) ? raw.map(String) : String(raw).split("\n")).map((s) => s.trim()).filter(Boolean)
  if (f.kind === "select" && f.none !== undefined) return toInput(raw) || null
  return raw
}

/**
 * What a dropdown offers: its options, after the `none` choice if it has one. A current value that
 * isn't among them (set before the list changed) is offered too, so showing the form never changes it.
 */
export const selectChoices = (f: SettingsField, current: unknown): SelectOption[] => {
  const choices = (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o.replace(/_/g, " ") } : { value: o.value, label: o.label }))
  const value = toInput(current)
  if (value && !choices.some((c) => c.value === value)) choices.push({ value, label: value })
  return f.none !== undefined ? [{ value: "", label: f.none }, ...choices] : choices
}

/**
 * The models Admin offers: what the local model server serves (docs/SERVER.md §9). It researches
 * through our own search service. The engine still validates whatever is picked.
 */
export const AI_MODELS: SelectOption[] = [{ value: "local/qwen3.6-35b-a3b-q2", label: "Qwen 3.6 35B-A3B" }]

/** The model settings, as both bots' Admin pages show them. */
export const AI_MODEL_FIELDS: SettingsField[] = [
  { path: "ai.models.research", label: "Research model", kind: "select", options: AI_MODELS },
  { path: "ai.models.decision", label: "Decision model", kind: "select", options: AI_MODELS },
]
