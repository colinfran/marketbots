"use client"

import type { ShadowAccount } from "@mb/core/agent"
import type { AgentStatusView, EpisodeRowView, EpisodeView, NoteView, ShadowFillView, ShadowPositionView, StepView, WatchView } from "@mb/core/agent-views"
import { cn } from "cn"
import { BrainIcon, LoaderIcon, MessageCircleQuestionIcon } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { Delta, Empty, Stat, SymbolLink } from "./bits"
import { Badge } from "./components/badge"
import { Button } from "./components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/table"
import { CommandResult, useCommand } from "./command"
import { Excerpt, Step, type StepStatus } from "./cycle-trail"
import { useKit } from "./kit"
import { ago, num, usd } from "./lib/format"
import { useNow } from "./live"
import { useStream } from "./stream"

/**
 * The agent's page (docs/plans/LOCAL-AI.md §11), the same in both dashboards: what it is doing
 * now (live, from the stream), its state, its shadow book, its watches and notes, its episodes and
 * one episode in full. Each app's /agent pages read the data (@mb/web-kit/agent) and lay these out.
 */

const PRIORITY = ["risk", "opportunity", "review", "background"] as const
const SPECIAL: Record<string, string> = { OWNER: "your question", MARKET: "the market", BOOK: "its book" }
const isSymbol = (s: string) => !(s in SPECIAL)

const OUTCOME_STYLE: Record<string, string> = {
  filled: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  updated: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  rejected: "border-transparent bg-red-500/15 text-red-800 dark:text-red-300",
  blocked: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
}

const STATUS_STYLE: Record<string, string> = {
  answered: OUTCOME_STYLE.filled,
  running: OUTCOME_STYLE.updated,
  aborted: OUTCOME_STYLE.blocked,
  no_answer: OUTCOME_STYLE.blocked,
  invalid: OUTCOME_STYLE.rejected,
  failed: OUTCOME_STYLE.rejected,
}

function Subject({ subject }: { subject: string }) {
  const kit = useKit()
  return isSymbol(subject) ? <SymbolLink symbol={subject} href={kit.symbolHref(subject)} /> : <span>{SPECIAL[subject]}</span>
}

function PriorityBadge({ priority }: { priority: number }) {
  return (
    <Badge variant="outline" className={cn("font-mono", priority === 0 && OUTCOME_STYLE.rejected, priority === 1 && OUTCOME_STYLE.filled)}>
      P{priority} {PRIORITY[priority] ?? ""}
    </Badge>
  )
}

function Outcome({ action, outcome, symbol }: { action: string; outcome: string; symbol: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono", OUTCOME_STYLE[outcome])} title={`${symbol} ${action}: ${outcome}`}>
      {symbol !== "unknown" ? `${symbol} ` : ""}
      {action.replace(/_/g, " ")} · {outcome.replace(/_/g, " ")}
    </Badge>
  )
}

/** The agent's state from the heartbeat: level, what it is doing, its queue, its speed, its breakers. */
export function AgentStatusCard({ status, online }: { status: AgentStatusView | null; online: boolean }) {
  const now = useNow()
  if (!status) return <Empty>The engine hasn&apos;t reported the agent yet: it starts with the engine.</Empty>
  const state = !online ? "engine offline" : status.state === "running" && status.episode ? `working on ${SPECIAL[status.episode.subject] ?? status.episode.subject}, step ${status.episode.step}` : status.state
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          The agent
          <Badge variant="outline" className={cn("font-mono uppercase", status.level === "shadow" ? OUTCOME_STYLE.updated : "text-muted-foreground")}>
            {status.level}
          </Badge>
        </CardTitle>
        <CardDescription>
          {status.level === "shadow" ? "Wakes when something matters, looks things up, and decides into its shadow book. Nothing it decides reaches the broker." : "Off: it makes no decisions."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs">Now</dt>
            <dd className="font-medium">{state}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Episodes today</dt>
            <dd className="tabular-nums">
              {status.episodes_today}
              <span className="text-muted-foreground"> · last {ago(status.last_episode_at, now)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Model</dt>
            <dd className="truncate font-mono text-xs">{status.model.replace(/^local\//, "")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Speed</dt>
            <dd className="tabular-nums">{status.tokens_per_s ? `${Math.round(status.tokens_per_s)} tokens/s` : "—"}</dd>
          </div>
        </dl>
        {status.blocked && <p className="text-amber-700 dark:text-amber-300">Waiting: {status.blocked}.</p>}
        {status.last_error && <p className="text-loss text-xs">Last error: {status.last_error}</p>}
        {status.queue.length > 0 && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Queued wake-ups</p>
            <ul className="flex flex-wrap gap-1.5">
              {status.queue.map((q) => (
                <li key={q.subject}>
                  <Badge variant="outline" className="font-mono">
                    P{q.priority} {SPECIAL[q.subject] ?? q.subject} · {q.observations}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {status.breakers.length > 0 && <p className="text-amber-700 dark:text-amber-300">Breakers tripped today (recorded, not enforced in shadow): {status.breakers.join(", ").replace(/_/g, " ")}.</p>}
      </CardContent>
    </Card>
  )
}

type LiveStep = Pick<StepView, "n" | "kind" | "tool" | "purpose" | "result" | "ms"> & { tokens_per_s: number | null }
type LiveEpisode = {
  id: string
  subject: string
  priority: number
  reasons: string[]
  steps: LiveStep[]
  thinking: string | null
  answered: { status: string; reply: string | null; actions: { symbol: string; action: string; outcome: string }[]; duration_ms: number } | null
}

const fromStored = (e: EpisodeView): LiveEpisode => ({
  id: e.id,
  subject: e.subject,
  priority: e.priority,
  reasons: e.observations.slice(0, 5).map((o) => o.summary),
  steps: e.steps.map((s) => ({ ...s, tokens_per_s: s.gen_per_s || null })),
  thinking: null,
  answered: e.status === "running" ? null : { status: e.status, reply: e.reply, actions: e.actions, duration_ms: e.duration_ms ?? 0 },
})

/** The episode running now (or the last one), step by step, as the stream reports it. */
export function AgentLive({ initial }: { initial: EpisodeView | null }) {
  const { events } = useStream()
  const live = useMemo(() => {
    const woke = [...events].reverse().find((e) => e.type === "agent.woke")
    if (!woke) return null
    const d = woke.data as { episode_id: string; subject: string; priority: number; reasons: string[] }
    const ep: LiveEpisode = { id: d.episode_id, subject: d.subject, priority: d.priority, reasons: d.reasons, steps: [], thinking: null, answered: null }
    for (const e of events) {
      const data = e.data as Record<string, unknown>
      if (data.episode_id !== ep.id) continue
      if (e.type === "agent.step") ep.steps = [...ep.steps.filter((s) => s.n !== data.step), { n: data.step as number, kind: data.kind as StepView["kind"], tool: data.tool as string | null, purpose: data.purpose as string | null, result: data.result as string | null, ms: data.ms as number, tokens_per_s: data.tokens_per_s as number | null }]
      else if (e.type === "agent.thinking") ep.thinking = data.excerpt as string
      else if (e.type === "agent.answered") ep.answered = { status: data.status as string, reply: data.reply as string | null, actions: data.actions as NonNullable<LiveEpisode["answered"]>["actions"], duration_ms: data.duration_ms as number }
    }
    return ep
  }, [events])
  // The stored episode is complete once it has finished (the page's history may lack its debug-level
  // steps); a newer or still-running episode comes from the stream.
  const stored = initial ? fromStored(initial) : null
  const ep = live && !(stored && live.id === stored.id && stored.answered) ? live : stored
  if (!ep) return <Empty>No episode yet. The agent wakes on news, setups, moves in what it holds, its watches, the session and a periodic review.</Empty>
  const running = !ep.answered
  const lastStep = ep.steps.at(-1)
  return (
    <ol>
      <Step n={1} title="Woke" status="done" aside={<PriorityBadge priority={ep.priority} />}>
        <p>
          About <Subject subject={ep.subject} />:
        </p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
          {ep.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </Step>
      {ep.steps
        .filter((s) => s.kind !== "answer")
        .map((s, i) => (
          <Step key={s.n} n={i + 2} title={s.kind === "tool" ? `Looked up: ${s.tool}` : "An invalid step"} status={s.kind === "invalid" ? "failed" : "done"} aside={`${(s.ms / 1000).toFixed(1)} s${s.tokens_per_s ? ` · ${Math.round(s.tokens_per_s)} tok/s` : ""}`}>
            {s.purpose && <p className="text-muted-foreground text-xs">{s.purpose}</p>}
            {s.result && <p className="bg-muted/40 rounded-md p-2 font-mono text-xs whitespace-pre-wrap">{s.result}</p>}
          </Step>
        ))}
      <Step
        n={ep.steps.filter((s) => s.kind !== "answer").length + 2}
        title={running ? (lastStep ? "Thinking it over" : "Reading the brief") : ep.answered!.status === "answered" ? "Answered" : `Ended: ${ep.answered!.status.replace("_", " ")}`}
        status={running ? "active" : ep.answered!.status === "answered" ? "done" : "failed"}
        aside={ep.answered ? `${Math.round(ep.answered.duration_ms / 1000)} s` : undefined}
      >
        {running && ep.thinking && <Excerpt label="Thinking" text={ep.thinking} icon={BrainIcon} />}
        {ep.answered?.reply && <p>{ep.answered.reply}</p>}
        {ep.answered && ep.answered.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ep.answered.actions.map((a, i) => (
              <Outcome key={i} {...a} />
            ))}
          </div>
        )}
        {ep.answered && (
          <Link href={`/agent/${ep.id}`} className="text-muted-foreground text-xs hover:underline">
            The whole episode
          </Link>
        )}
      </Step>
    </ol>
  )
}

/** The shadow book: what the agent would hold, at what it would have paid. */
export function ShadowBook({ account, open, closed, fills }: { account: ShadowAccount | null; open: ShadowPositionView[]; closed: ShadowPositionView[]; fills: ShadowFillView[] }) {
  const kit = useKit()
  return (
    <div className="space-y-4">
      {account && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Shadow equity" value={usd(account.equity_usd)} sub={<Delta value={account.equity_usd - account.starting_usd} percent={account.return_pct} />} />
          <Stat label="Cash" value={usd(account.cash_usd)} sub={<span className="text-muted-foreground">started with {usd(account.starting_usd, { whole: true })}</span>} />
          <Stat label="Realized" value={<Delta value={account.realized_pnl_usd} className="text-2xl" />} sub={<span className="text-muted-foreground">{account.closed_positions} closed</span>} />
          <Stat label="Open" value={usd(account.exposure_usd)} sub={<Delta value={account.unrealized_pnl_usd} />} />
        </div>
      )}
      {open.length === 0 ? (
        <Empty>The shadow book holds nothing right now.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Now</TableHead>
              <TableHead className="text-right">Stop / target</TableHead>
              <TableHead>Thesis</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {open.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <SymbolLink symbol={p.symbol} href={kit.symbolHref(p.symbol)} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(p.qty, 8)}</TableCell>
                <TableCell className="text-right tabular-nums">{kit.format.price(p.entry_price)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {kit.format.price(p.mark_price)} {p.mark_price !== null && <Delta percent={(p.mark_price / p.entry_price - 1) * 100} className="text-xs" />}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {kit.format.price(p.stop_price)} / {kit.format.price(p.take_profit_price)}
                </TableCell>
                <TableCell className="max-w-md text-xs">
                  <Link href={`/agent/${p.episode_id}`} className="hover:underline">
                    {p.thesis}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {closed.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Closed</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead className="text-right">Entry → exit</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">P&amp;L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {closed.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{kit.format.dateTime(p.closed_at ?? p.opened_at)}</TableCell>
                <TableCell>
                  <SymbolLink symbol={p.symbol} href={kit.symbolHref(p.symbol)} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {kit.format.price(p.entry_price)} → {kit.format.price(p.exit_price)}
                </TableCell>
                <TableCell className="text-xs">{(p.exit_reason ?? "").replace(/_/g, " ")}</TableCell>
                <TableCell className="text-right">
                  <Delta value={p.realized_pnl_usd} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {fills.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">The last {fills.length} shadow fills</summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {fills.map((f) => (
              <li key={f.id}>
                {kit.format.dateTime(f.at)} {f.side} {num(f.qty, 8)} {f.symbol} at {kit.format.price(f.price)} ({f.reason.replace(/_/g, " ")}){f.realized_pnl_usd !== null && <> · {usd(f.realized_pnl_usd, { sign: true })}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** The agent's active watches and notes. */
export function AgentMemory({ watches, notes }: { watches: WatchView[]; notes: NoteView[] }) {
  const kit = useKit()
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Watches</h3>
        {watches.length === 0 ? (
          <Empty>No active watches.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {watches.map((w) => (
              <li key={w.id} className="rounded-md border p-2">
                <p className="font-medium">
                  {w.what} <span className="text-muted-foreground text-xs">P{w.priority} · until {kit.format.dateTime(w.expires_at)}</span>
                </p>
                <p className="text-muted-foreground text-xs">{w.note}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Notes</h3>
        {notes.length === 0 ? (
          <Empty>No notes yet.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border p-2">
                <p className="text-xs">
                  <Subject subject={n.subject} /> <span className="text-muted-foreground">{kit.format.dateTime(n.created_at)}</span>
                </p>
                <p className="text-muted-foreground text-xs">{n.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Recent episodes, newest first. */
export function EpisodeTable({ rows }: { rows: EpisodeRowView[] }) {
  const kit = useKit()
  if (!rows.length) return <Empty>No episodes yet.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>About</TableHead>
          <TableHead>Why</TableHead>
          <TableHead>Looked up</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Reply</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="text-xs whitespace-nowrap">
              <Link href={`/agent/${r.id}`} className="hover:underline">
                {kit.format.dateTime(r.started_at)}
              </Link>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Subject subject={r.subject} /> <PriorityBadge priority={r.priority} />
            </TableCell>
            <TableCell className="text-muted-foreground text-xs">{r.kinds.join(", ")}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{r.tools.length ? r.tools.join(", ") : "nothing"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline" className={cn("font-mono", STATUS_STYLE[r.status])}>
                  {r.status.replace("_", " ")}
                </Badge>
                {r.actions.map((a, i) => (
                  <Outcome key={i} {...a} />
                ))}
              </div>
            </TableCell>
            <TableCell className="max-w-md text-xs">{r.reply ?? r.error ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const stepStatus = (s: StepView): StepStatus => (s.kind === "invalid" || s.error ? "failed" : "done")

/** One episode in full: why it woke, each step (its thinking when shown), the answer and what came of it. */
export function EpisodeDetail({ episode: e }: { episode: EpisodeView }) {
  const kit = useKit()
  return (
    <div className="space-y-6">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <PriorityBadge priority={e.priority} />
        <Badge variant="outline" className={cn("font-mono", STATUS_STYLE[e.status])}>
          {e.status.replace("_", " ")}
        </Badge>
        <span>
          {kit.format.dateTime(e.started_at)} · {e.duration_ms !== null ? `${Math.round(e.duration_ms / 1000)} s` : "running"} · {e.steps.length} steps · {num(e.usage.input, 0)} tokens read, {num(e.usage.output, 0)} written · {e.model.replace(/^local\//, "")} · {e.prompt_version} · level {e.level}
        </span>
      </div>
      {e.error && <p className="text-loss text-sm">{e.error}</p>}
      <section>
        <h2 className="mb-2 text-base font-semibold">Why it woke</h2>
        {e.question && <p className="mb-2 text-sm">The owner asked: {e.question}</p>}
        <ul className="space-y-1 text-sm">
          {e.observations.map((o, i) => (
            <li key={i}>
              <span className="text-muted-foreground font-mono text-xs">
                {kit.format.time(o.at)} {o.kind} P{o.priority} · {o.salience}
              </span>{" "}
              {o.summary}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">Steps</h2>
        <ol>
          {e.steps.map((s) => (
            <Step key={s.n} n={s.n} title={s.kind === "tool" ? `Looked up: ${s.tool}` : s.kind === "answer" ? "Answered" : "Invalid step"} status={stepStatus(s)} aside={`${(s.ms / 1000).toFixed(1)} s · ${s.prompt_tokens} in (${s.cached_tokens} cached) · ${s.completion_tokens} out${s.gen_per_s ? ` · ${Math.round(s.gen_per_s)} tok/s` : ""}`}>
              {s.purpose && <p className="text-muted-foreground text-xs">{s.purpose}</p>}
              {s.thinking && (
                <details>
                  <summary className="text-muted-foreground cursor-pointer text-xs">Its thinking ({s.thinking.length.toLocaleString("en-US")} characters)</summary>
                  <p className="bg-muted/40 mt-1 rounded-md p-2 text-xs leading-relaxed whitespace-pre-wrap">{s.thinking}</p>
                </details>
              )}
              {s.args && <p className="font-mono text-xs">args {s.args}</p>}
              {s.result && <p className="bg-muted/40 rounded-md p-2 font-mono text-xs whitespace-pre-wrap">{s.result}</p>}
              {s.error && <p className="text-loss text-xs">{s.error}</p>}
            </Step>
          ))}
        </ol>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">What came of it</h2>
        {e.reply && <p className="mb-2 text-sm">{e.reply}</p>}
        {e.actions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No decisions{e.question ? " (an owner's question is read-only)" : ""}.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {e.actions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Outcome {...a} /> <span className="text-muted-foreground text-xs">{a.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {e.memory.length > 0 && <p className="text-muted-foreground mt-2 text-xs">{e.memory.join(" · ")}</p>}
      </section>
      <details>
        <summary className="text-muted-foreground cursor-pointer text-sm">The brief it got</summary>
        <pre className="bg-muted/40 mt-2 overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">{e.brief}</pre>
      </details>
      {e.answer && (
        <details>
          <summary className="text-muted-foreground cursor-pointer text-sm">Its answer as written</summary>
          <pre className="bg-muted/40 mt-2 overflow-x-auto rounded-md p-3 text-xs">{e.answer}</pre>
        </details>
      )}
    </div>
  )
}

/** The owner's question for the agent: a read-only episode; the reply shows above when it's done. */
export function AskAgentForm({ disabled }: { disabled: boolean }) {
  const [question, setQuestion] = useState("")
  const { busy, result, error, send } = useCommand<{ type: "agent.ask"; question: string }>()
  return (
    <form
      className="space-y-2"
      onSubmit={(ev) => {
        ev.preventDefault()
        if (question.trim().length >= 3) void send({ type: "agent.ask", question: question.trim() }).then((ok) => ok && setQuestion(""))
      }}
    >
      <div className="flex gap-2">
        <input
          aria-label="Your question"
          className="bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-sm"
          maxLength={500}
          placeholder="Why didn't you buy SOL this morning?"
          value={question}
          onChange={(ev) => setQuestion(ev.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || disabled || question.trim().length < 3}>
          {busy ? <LoaderIcon className="animate-spin" aria-hidden /> : <MessageCircleQuestionIcon aria-hidden />}
          Ask
        </Button>
      </div>
      <CommandResult result={result} error={error} />
    </form>
  )
}
