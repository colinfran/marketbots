"use client"

import type { BaseCommand } from "@mb/core/commands"
import { LoaderIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { CommandResult, useCommand } from "./command"
import { Button } from "./components/button"
import { Input } from "./components/input"
import { Label } from "./components/label"
import { Switch } from "./components/switch"

/**
 * Every tunable setting, grouped into the sections each app passes in. Only changed fields are
 * sent, as a patch the engine validates against the full schema (with optimistic concurrency, so
 * two tabs can't overwrite each other).
 */

/** list: comma-separated tickers (uppercased). idlist: comma-separated ids. lines: one entry per line, for entries that contain commas. */
export type SettingsField = { path: string; label: string; kind: "number" | "boolean" | "text" | "list" | "idlist" | "lines" | "select"; options?: string[]; step?: number }

export type SettingsSection = { title: string; fields: SettingsField[] }

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], obj)

const setIn = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split(".")
  let cur = obj
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
  cur[keys.at(-1)!] = value
}

const toInput = (v: unknown, separator = ", ") => (Array.isArray(v) ? v.join(separator) : v === null || v === undefined ? "" : String(v))

export function SettingsForm({ sections, settings, version }: { sections: SettingsSection[]; settings: object; version: number }) {
  const initial = useMemo(() => Object.fromEntries(sections.flatMap((g) => g.fields).map((f) => [f.path, get(settings, f.path)])), [sections, settings])
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const { busy, result, error, send } = useCommand<BaseCommand>()
  const fields = sections.flatMap((g) => g.fields)
  const parse = (f: SettingsField, raw: unknown): unknown => {
    if (f.kind === "number") return Number(raw)
    if (f.kind === "list") return String(raw).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (f.kind === "idlist") return String(raw).split(",").map((s) => s.trim()).filter(Boolean)
    if (f.kind === "lines") return (Array.isArray(raw) ? raw.map(String) : String(raw).split("\n")).map((s) => s.trim()).filter(Boolean)
    if (f.kind === "text" && f.path === "ai.models.fallback") return toInput(raw).trim() || null
    return raw
  }
  const changed = fields.filter((f) => JSON.stringify(parse(f, values[f.path])) !== JSON.stringify(initial[f.path]))

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        const patch: Record<string, unknown> = {}
        for (const f of changed) setIn(patch, f.path, parse(f, values[f.path]))
        void send({ type: "settings.update", patch, expected_version: version })
      }}
    >
      {sections.map((g) => (
        <fieldset key={g.title} className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">{g.title}</legend>
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {g.fields.map((f) => {
              const id = `s-${f.path}`
              const dirty = changed.includes(f)
              if (f.kind === "lines") {
                return (
                  <div key={f.path} className="space-y-1.5 md:col-span-2">
                    <Label htmlFor={id} className={dirty ? "text-foreground font-medium" : "text-muted-foreground font-normal"}>
                      {f.label}
                      {dirty && " •"}
                    </Label>
                    <textarea
                      id={id}
                      rows={4}
                      className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:ring-3"
                      value={toInput(values[f.path], "\n")}
                      onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}
                    />
                  </div>
                )
              }
              return (
                <div key={f.path} className="flex items-center justify-between gap-3">
                  <Label htmlFor={id} className={dirty ? "text-foreground font-medium" : "text-muted-foreground font-normal"}>
                    {f.label}
                    {dirty && " •"}
                  </Label>
                  {f.kind === "boolean" ? (
                    <Switch id={id} checked={Boolean(values[f.path])} onCheckedChange={(v) => setValues({ ...values, [f.path]: v })} />
                  ) : f.kind === "select" ? (
                    <select id={id} className="bg-background h-8 rounded-md border px-2 text-sm" value={String(values[f.path])} onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}>
                      {f.options!.map((o) => (
                        <option key={o} value={o}>
                          {o.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      className={f.kind === "number" ? "w-28 text-right font-mono" : "w-64 font-mono text-xs"}
                      type={f.kind === "number" ? "number" : "text"}
                      step={f.step ?? "any"}
                      value={toInput(values[f.path])}
                      onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
      <div className="bg-background/90 sticky bottom-0 flex flex-wrap items-center gap-3 border-t py-3 backdrop-blur">
        <Button type="submit" disabled={busy || changed.length === 0}>
          {busy && <LoaderIcon className="animate-spin" aria-hidden />}
          Save {changed.length ? `${changed.length} change${changed.length > 1 ? "s" : ""}` : ""}
        </Button>
        {changed.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => setValues(initial)}>
            Discard
          </Button>
        )}
        <CommandResult result={result} error={error} />
        <span className="text-muted-foreground ml-auto text-xs">settings v{version} · validated by the engine before it applies them</span>
      </div>
    </form>
  )
}
