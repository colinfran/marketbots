import type { DatabaseStorageView, EngineStatusBase } from "@mb/core/db"
import type { WireSourceHealth } from "@mb/core/wire"
import { cn } from "cn"
import Link from "next/link"
import { Empty, KV, Meter, SectionTitle } from "./bits"
import { Badge } from "./components/badge"
import { Card, CardContent, CardHeader, CardTitle } from "./components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/table"
import { ago, bytes, duration, num, titleCase } from "./lib/format"

/**
 * The building blocks of the Admin page's system health: the engine, AI, server, database and stream
 * cards, the news engine's summary and the recent problems. Each app lays them out with its own venue or
 * broker cards and its own price table. The news-source table is on the News page, for the owner.
 */

type Status = EngineStatusBase<string, string>

/** Green (up) or red (down). */
export const HealthDot = ({ ok }: { ok: boolean }) => <span className={cn("inline-block size-2 rounded-full", ok ? "bg-up" : "bg-down")} aria-hidden />

/** The engine card. The bot fills in what it's doing (`activity`) and any rows of its own. */
export function EngineHealthCard({
  engine,
  dateTime,
  activity,
  children,
}: {
  engine: { online: boolean; heartbeatAgeS: number | null; status: Status }
  dateTime: (value: Date) => string
  activity: React.ReactNode
  children?: React.ReactNode
}) {
  const s = engine.status
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HealthDot ok={engine.online} /> Engine
        </CardTitle>
      </CardHeader>
      <CardContent>
        <KV label="State">{engine.online ? titleCase(s.status) : "offline"}</KV>
        <KV label="Activity">{activity}</KV>
        <KV label="Last heartbeat">{engine.heartbeatAgeS === null ? "—" : `${engine.heartbeatAgeS}s ago`}</KV>
        <KV label="Kill switch">{s.kill_switch ? <Badge variant="destructive">engaged</Badge> : "off"}</KV>
        <KV label="Up since">{dateTime(s.started_at)}</KV>
        <KV label="Version / host">
          {s.version} / {s.instance}
        </KV>
        {children}
        <KV label="Errors (1h)">{s.errors_last_hour}</KV>
      </CardContent>
    </Card>
  )
}

/** The model server as the engine sees it, and the agent's model. */
export function AiHealthCard({ ai, model }: { ai: Status["ai"]; model: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HealthDot ok={ai.enabled && !ai.last_error} /> AI (local model server)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <KV label="Enabled">{ai.enabled ? "yes" : "no (LLM_URL missing)"}</KV>
        <KV label="Agent's model">{model ? model.replace(/^local\//, "") : "—"}</KV>
        <KV label="Calls today">{ai.calls_today}</KV>
        <KV label="Last call">{ago(ai.last_call_at)}</KV>
        {ai.last_error && <p className="text-loss mt-2 line-clamp-3 text-xs">{ai.last_error}</p>}
      </CardContent>
    </Card>
  )
}

export function ServerHealthCard({ system }: { system: Status["system"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Server resources</CardTitle>
      </CardHeader>
      <CardContent>
        <KV label="CPU (engine)">{num(system.cpu_pct, 1)}%</KV>
        <KV label="Memory (RSS / heap)">
          {system.rss_mb} / {system.heap_mb} MB
        </KV>
        <KV label="Load average">{system.load_avg.join(" · ")}</KV>
        <KV label="Process uptime">{duration(system.uptime_s * 1000)}</KV>
      </CardContent>
    </Card>
  )
}

/** The history store card: the bot's own Postgres database with its 1-minute bars and news archive. */
export function HistoryHealthCard({ history }: { history: NonNullable<Status["history"]> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HealthDot ok={history.ok} /> History store
        </CardTitle>
      </CardHeader>
      <CardContent>
        <KV label="State">{history.ok ? "ok" : history.ready ? "errors" : "unreachable"}</KV>
        <KV label="Bars written">
          {num(history.bars.written, 0)}
          {history.bars.buffered > 0 ? ` · ${num(history.bars.buffered, 0)} waiting` : ""}
          {history.bars.dropped > 0 ? ` · ${num(history.bars.dropped, 0)} dropped` : ""}
        </KV>
        <KV label="Last bar">{ago(history.bars.last_at)}</KV>
        <KV label="News archive">
          {num(history.news.items, 0)} items · {num(history.news.triggers, 0)} triggers
        </KV>
        <KV label="Last copy / sync">
          {ago(history.news.last_append_at)} / {ago(history.news.last_sync_at)}
        </KV>
        {history.jobs && history.jobs.length > 0 && (
          <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
            {history.jobs.map((j) => (
              <li key={j.name}>
                <span className="font-mono">{j.name}</span> {j.state}
                {j.progress ? `: ${j.progress}` : ""}
                {j.error && <span className="text-loss"> ({j.error})</span>}
              </li>
            ))}
          </ul>
        )}
        {history.last_error && <p className="text-loss mt-2 text-xs">{history.last_error}</p>}
      </CardContent>
    </Card>
  )
}

/** The MongoDB cluster both bots share: its databases on disk against the storage cap, read when the page loads. */
export function DatabaseStorageCard({ storage }: { storage: DatabaseStorageView }) {
  const used = storage.used_bytes
  const usedPct = used === null ? null : (used / storage.limit_bytes) * 100
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HealthDot ok={usedPct !== null && usedPct < 80} /> Database storage
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Meter value={usedPct} className="mb-2" />
        <KV label="Used">{used === null ? "—" : `${bytes(used)} of ${bytes(storage.limit_bytes)} (${num(usedPct, 1)}%)`}</KV>
        <KV label="Free">{used === null ? "—" : bytes(Math.max(0, storage.limit_bytes - used))}</KV>
        {storage.databases.map((d) => (
          <KV key={d.name} label={d.name}>
            {bytes(d.bytes)}
          </KV>
        ))}
        {storage.error ? (
          <p className="text-loss mt-2 line-clamp-3 text-xs">{storage.error}</p>
        ) : (
          <p className="text-muted-foreground mt-2 text-xs">The Azure DocumentDB free tier, shared by both bots. Azure&apos;s own storage metric also counts its logs and system files.</p>
        )}
      </CardContent>
    </Card>
  )
}

/** The live stream card; `children` are the bot's extra rows. */
export function StreamHealthCard({ status, children }: { status: Pick<Status, "ws_clients" | "event_seq">; children?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live stream</CardTitle>
      </CardHeader>
      <CardContent>
        <KV label="Connected dashboards">{status.ws_clients}</KV>
        <KV label="Last event seq">{status.event_seq}</KV>
        {children}
      </CardContent>
    </Card>
  )
}

/** Every news source with its health. `note` renders the last column (the bot's notes and errors). */
export function WireSourcesSection({ wire, note }: { wire: NonNullable<Status["wire"]>; note: (source: WireSourceHealth) => React.ReactNode }) {
  return (
    <section>
      <SectionTitle>
        News engine sources · mode {wire.mode} · {wire.items_last_hour} items in the last hour · {wire.triggers_today} triggers today
      </SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Items 24h</TableHead>
            <TableHead className="text-right">Dropped 24h</TableHead>
            <TableHead className="text-right">Lag</TableHead>
            <TableHead>Last OK</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {wire.sources.map((w) => (
            <TableRow key={w.id}>
              <TableCell className="font-mono text-xs">{w.id}</TableCell>
              <TableCell className={cn("text-sm", (w.state === "degraded" || w.state === "down") && "text-loss")}>{w.state}</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">{w.items_24h}</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">{w.dropped_24h}</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">{w.lag_s === null ? "—" : duration(w.lag_s * 1000)}</TableCell>
              <TableCell className="text-muted-foreground text-xs">{ago(w.last_ok_at)}</TableCell>
              {note(w)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

/** Admin's one line on the news engine; every source with its errors is on the News page. */
export function WireSourcesSummary({ wire }: { wire: NonNullable<Status["wire"]> }) {
  const running = wire.sources.filter((s) => s.state !== "disabled")
  const ok = running.filter((s) => s.state === "ok").length
  return (
    <section>
      <SectionTitle>News engine</SectionTitle>
      <p className="text-muted-foreground text-sm">
        Mode {wire.mode} · {ok} of {running.length} sources ok · {wire.items_last_hour} items in the last hour · {wire.triggers_today} triggers today. Every source with its
        errors is on{" "}
        <Link href="/news" className="text-foreground underline underline-offset-2">
          News
        </Link>
        .
      </p>
    </section>
  )
}

/** Recent warnings and errors; `timeClassName` sizes the time column for the bot's date format. */
export function ProblemsSection({ problems, dateTime, timeClassName }: { problems: { seq: number; ts: string; level: string; summary: string }[]; dateTime: (value: string) => string; timeClassName: string }) {
  return (
    <section>
      <SectionTitle>Recent warnings & errors</SectionTitle>
      {problems.length === 0 ? (
        <Empty>Nothing recent.</Empty>
      ) : (
        <ul className="space-y-1 text-sm">
          {problems.map((e) => (
            <li key={e.seq} className="flex gap-3">
              <span className={cn("text-muted-foreground shrink-0 font-mono text-xs", timeClassName)}>{dateTime(e.ts)}</span>
              <span className={e.level === "error" ? "text-loss" : ""}>{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
