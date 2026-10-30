"use client"

import type { ModelCallKind } from "@mb/core/events"
import { cn } from "cn"
import { BotIcon, BrainIcon, CpuIcon, FileTextIcon, LoaderIcon, SearchIcon } from "lucide-react"
import Link from "next/link"
import { useLayoutEffect, useRef } from "react"
import { Badge } from "./components/badge"
import { num } from "./lib/format"
import { useNow } from "./live"
import { useStream, type ModelCallView, type ModelServerView } from "./stream"

/**
 * The live model feed, the same in both dashboards: everything the local model is doing for this
 * bot, as it is written. Each call the engine makes (an agent step, an article summary, a research
 * step) appears when it starts, its thinking and output stream in about once a second, and it
 * moves to the recent list when it ends. Above them, the model server's slots (shared by both bots
 * and the news summaries). The model's text is shown as text, never as markup.
 */

const KIND: Record<ModelCallKind, { label: string; icon: typeof BotIcon; className: string }> = {
  agent: { label: "Agent", icon: BotIcon, className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  summary: { label: "Summary", icon: FileTextIcon, className: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  research: { label: "Research", icon: SearchIcon, className: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300" },
}

const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`)

/** A box of streaming text that keeps its newest line in view, unless the reader scrolled up. */
function Streaming({ text, label, icon: Icon, live, className }: { text: string; label: string; icon: typeof BrainIcon; live: boolean; className?: string }) {
  const box = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className={className}>
      <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
        <Icon className="size-3" aria-hidden />
        {label}
        <span className="font-normal normal-case tabular-nums">· {num(text.length, 0)} chars</span>
      </p>
      <pre
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className={cn("bg-muted/40 max-h-72 overflow-y-auto rounded-md p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap", live && "border-foreground/10 border")}
      >
        {text}
        {live && <span className="bg-foreground/60 ml-0.5 inline-block h-3 w-1.5 align-middle motion-safe:animate-pulse" aria-hidden />}
      </pre>
    </div>
  )
}

function KindBadge({ kind }: { kind: ModelCallKind }) {
  const k = KIND[kind]
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", k.className)}>
      <k.icon className="size-3" aria-hidden />
      {k.label}
    </Badge>
  )
}

/** One call: running, with its text streaming, or ended. */
export function ModelCallCard({ call, now, textShown }: { call: ModelCallView; now: number; textShown: boolean }) {
  const running = !call.done
  const ms = call.done ? call.done.ms : now - call.started_at
  const empty = !call.thinking && !call.output
  return (
    <article className={cn("rounded-lg border p-3", running && "border-foreground/20 shadow-sm")}>
      <header className="flex flex-wrap items-center gap-2">
        <KindBadge kind={call.kind} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={call.label}>
          {call.label}
        </h3>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums">
          {running ? <LoaderIcon className="size-3 motion-safe:animate-spin" aria-hidden /> : null}
          {seconds(ms)}
          {call.done?.tokens_per_s ? ` · ${Math.round(call.done.tokens_per_s)} tok/s` : ""}
          {call.done && call.done.completion_tokens > 0 ? ` · ${num(call.done.completion_tokens, 0)} written` : ""}
        </span>
      </header>
      {call.done && !call.done.ok && <p className="text-loss mt-1 text-xs">Failed: {call.done.error ?? "unknown error"}</p>}
      {!empty && (
        <div className="mt-2 grid gap-2">
          {call.thinking && <Streaming text={call.thinking} label="Thinking" icon={BrainIcon} live={running && !call.output} />}
          {call.output && <Streaming text={call.output} label={call.kind === "agent" ? "Its step" : "Output"} icon={FileTextIcon} live={running} />}
        </div>
      )}
      {empty && running && <p className="text-muted-foreground mt-2 text-xs">{textShown ? "Reading its prompt…" : "Its text is shown to the owner."}</p>}
      {call.episode_id && (
        <Link href={`/agent/${call.episode_id}`} className="text-muted-foreground mt-2 inline-block text-xs hover:underline">
          The episode{call.step ? `, step ${call.step}` : ""}
        </Link>
      )}
    </article>
  )
}

/** The model server's slots: which are working, on what, and how far along. */
export function ModelServer({ server }: { server: ModelServerView | null }) {
  const now = useNow(5_000)
  if (!server) return <p className="text-muted-foreground text-xs">Waiting for the model server&apos;s status…</p>
  if (!server.ok) return <p className="text-loss text-xs">Model server: {server.error ?? "unreachable"}</p>
  const busy = server.slots.filter((s) => s.busy).length
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <CpuIcon className="size-3.5" aria-hidden />
        Model server: {busy} of {server.slots.length} slots working
      </span>
      {server.slots.map((s) => (
        <span key={s.id} className={cn("rounded-md border px-2 py-0.5 tabular-nums", s.busy ? "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300" : "text-muted-foreground")}>
          slot {s.id}
          {s.busy ? (s.prompt_done < s.prompt_tokens ? ` · reading ${num(s.prompt_done, 0)}/${num(s.prompt_tokens, 0)}` : ` · writing, ${num(s.decoded, 0)} tokens`) : " · idle"}
        </span>
      ))}
      {now - server.at > 10_000 && <span className="text-muted-foreground">(as of {Math.round((now - server.at) / 1000)} s ago)</span>}
    </div>
  )
}

/**
 * Everything the model is doing for this bot, live. `textShown`: whether this viewer gets the
 * model's text (the owner, or everyone when agent.public_thinking is on).
 */
export function ModelFeed({ textShown, recent = 12, className }: { textShown: boolean; recent?: number; className?: string }) {
  const { models, status } = useStream()
  const now = useNow(1_000)
  const running = models.calls.filter((c) => !c.done)
  const ended = models.calls.filter((c) => c.done).slice(0, recent)
  return (
    <div className={cn("space-y-4", className)}>
      <ModelServer server={models.server} />
      <section aria-label="Working now" aria-live="polite" className="space-y-3">
        {running.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            {status === "unconfigured" ? "The live stream isn't configured (ENGINE_STREAM_URL)." : status !== "live" ? `The live stream is ${status}.` : "The model is idle for this bot right now. The next call appears here as it starts."}
          </p>
        ) : (
          running.map((c) => <ModelCallCard key={c.id} call={c} now={now} textShown={textShown} />)
        )}
      </section>
      {ended.length > 0 && (
        <section aria-label="Just finished" className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Just finished</h3>
          <ol className="space-y-1.5">
            {ended.map((c) => (
              <li key={c.id}>
                <details className="group rounded-lg border">
                  <summary className="hover:bg-muted/40 flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2">
                    <KindBadge kind={c.kind} />
                    <span className="min-w-0 flex-1 truncate text-sm">{c.label}</span>
                    <span className={cn("text-xs tabular-nums", c.done?.ok ? "text-muted-foreground" : "text-loss")}>
                      {c.done?.ok ? "" : "failed · "}
                      {seconds(c.done?.ms ?? 0)}
                      {c.done?.tokens_per_s ? ` · ${Math.round(c.done.tokens_per_s)} tok/s` : ""}
                    </span>
                  </summary>
                  <div className="border-t p-3">
                    <ModelCallCard call={c} now={now} textShown={textShown} />
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
