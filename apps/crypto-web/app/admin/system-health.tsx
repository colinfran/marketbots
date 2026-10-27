import type { EngineEvent } from "@mb/crypto-core/events"
import { Empty, KV, SectionTitle } from "@/components/bits"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { EngineSummary } from "@/lib/data"
import { ago, dateTime, duration, num, price, titleCase } from "@/lib/format"
import { cn } from "@/lib/utils"

const Dot = ({ ok }: { ok: boolean }) => <span className={cn("inline-block size-2 rounded-full", ok ? "bg-up" : "bg-down")} aria-hidden />

/** Health of the engine on the trading server and everything it depends on. */
export function SystemHealth({ engine, problems }: { engine: EngineSummary; problems: EngineEvent[] }) {
  const s = engine.status
  return (
    <div className="space-y-8">
      {!s ? (
        <Empty>The engine has never reported in. Check that the Docker container is running and can reach MongoDB.</Empty>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Dot ok={engine.online} /> Engine
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="State">{engine.online ? titleCase(s.status) : "offline"}</KV>
                <KV label="Activity">{titleCase(s.cycle_state)}{s.current_task ? ` · ${s.current_task}` : ""}</KV>
                <KV label="Last heartbeat">{engine.heartbeatAgeS === null ? "—" : `${engine.heartbeatAgeS}s ago`}</KV>
                <KV label="Kill switch">{s.kill_switch ? <Badge variant="destructive">engaged</Badge> : "off"}</KV>
                <KV label="Up since">{dateTime(s.started_at)}</KV>
                <KV label="Version / host">
                  {s.version} / {s.instance}
                </KV>
                <KV label="Last cycle">{s.last_cycle ? `${s.last_cycle.status}, ${ago(s.last_cycle.at)}` : "—"}</KV>
                <KV label="Errors (1h)">{s.errors_last_hour}</KV>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Dot ok={s.kraken.ws === "connected" && s.kraken.rest === "ok"} /> Kraken market data
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="WebSocket">{s.kraken.ws}</KV>
                <KV label="REST">{s.kraken.rest}</KV>
                <KV label="Exchange status">{s.kraken.status_text ?? "—"}</KV>
                <KV label="Last message">{ago(s.kraken.last_message_at)}</KV>
                {s.kraken.last_error && <p className="text-loss mt-2 text-xs">{s.kraken.last_error}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Dot ok={s.paper_wallet.ok && (s.reconciliation?.ok ?? false)} /> Paper wallet (Kraken CLI)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="CLI">{s.paper_wallet.ok ? `ok · ${s.paper_wallet.cli_version ?? ""}` : "unavailable"}</KV>
                <KV label="Workspace">{s.paper_wallet.workspace}</KV>
                <KV label="Fee / slippage">
                  {s.paper_wallet.fee_bps ?? "—"} / {s.paper_wallet.slippage_bps ?? "—"} bps
                </KV>
                <KV label="Books vs wallet">{s.reconciliation ? (s.reconciliation.ok ? `match (${ago(s.reconciliation.at)})` : "mismatch: new entries blocked") : "not checked yet"}</KV>
                {s.paper_wallet.last_error && <p className="text-loss mt-2 text-xs">{s.paper_wallet.last_error}</p>}
                {s.reconciliation && s.reconciliation.issues.length > 0 && (
                  <ul className="text-muted-foreground mt-2 list-disc space-y-0.5 pl-4 text-xs">
                    {s.reconciliation.issues.map((i, n) => (
                      <li key={n}>{i}</li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Dot ok={s.ai.enabled && !s.ai.last_error} /> AI (Grok via Vercel AI Gateway)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="Enabled">{s.ai.enabled ? "yes" : "no (AI_GATEWAY_API_KEY missing)"}</KV>
                <KV label="Research model">{s.ai.models.research}</KV>
                <KV label="Decision model">{s.ai.models.decision}</KV>
                <KV label="Fallback">{s.ai.models.fallback ?? "none"}</KV>
                <KV label="Spend today">
                  ${num(s.ai.spend_today_usd, 3)} / ${s.ai.budget_usd} ({s.ai.calls_today} calls)
                </KV>
                <KV label="Last call">{ago(s.ai.last_call_at)}</KV>
                {s.ai.last_error && <p className="text-loss mt-2 line-clamp-3 text-xs">{s.ai.last_error}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Server resources</CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="CPU (engine)">{num(s.system.cpu_pct, 1)}%</KV>
                <KV label="Memory (RSS / heap)">
                  {s.system.rss_mb} / {s.system.heap_mb} MB
                </KV>
                <KV label="Load average">{s.system.load_avg.join(" · ")}</KV>
                <KV label="Process uptime">{duration(s.system.uptime_s * 1000)}</KV>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Live stream</CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="Connected dashboards">{s.ws_clients}</KV>
                <KV label="Last event seq">{s.event_seq}</KV>
                <KV label="Next scheduled scan">{dateTime(s.next_cycle_at)}</KV>
              </CardContent>
            </Card>
          </div>

          <section>
            <SectionTitle>Data freshness</SectionTitle>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead className="text-right">Bid</TableHead>
                  <TableHead className="text-right">Ask</TableHead>
                  <TableHead className="text-right">Quote age</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.symbols.map((x) => (
                  <TableRow key={x.symbol}>
                    <TableCell className="font-mono text-sm">{x.symbol}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{price(x.bid)}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{price(x.ask)}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{x.age_s === null ? "—" : `${num(x.age_s, 1)}s`}</TableCell>
                    <TableCell className={cn("text-sm", x.stale && "text-loss")}>{x.stale ? "stale: no new entries" : "fresh"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          {s.wire && (
            <section>
              <SectionTitle>
                News engine sources · mode {s.wire.mode} · {s.wire.items_last_hour} items in the last hour · {s.wire.triggers_today} triggers today
                {s.wire.event_queue.length ? ` · queued: ${s.wire.event_queue.join(", ")}` : ""}
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
                  {s.wire.sources.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="font-mono text-xs">{w.id}</TableCell>
                      <TableCell className={cn("text-sm", (w.state === "degraded" || w.state === "down") && "text-loss")}>{w.state}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{w.items_24h}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{w.dropped_24h}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{w.lag_s === null ? "—" : duration(w.lag_s * 1000)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{ago(w.last_ok_at)}</TableCell>
                      <TableCell className="text-muted-foreground max-w-xs truncate text-xs" title={w.last_error ?? ""}>
                        {w.last_error ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
        </>
      )}

      <section>
        <SectionTitle>Recent warnings & errors</SectionTitle>
        {problems.length === 0 ? (
          <Empty>Nothing recent.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {problems.map((e) => (
              <li key={e.seq} className="flex gap-3">
                <span className="text-muted-foreground w-28 shrink-0 font-mono text-xs">{dateTime(e.ts)}</span>
                <span className={e.level === "error" ? "text-loss" : ""}>{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
