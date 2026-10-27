import type { EngineEvent } from "@mb/stock-core/events"
import { formatDateTime } from "@mb/stock-core/time"
import { Empty, KV, SectionTitle } from "@/components/bits"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ago, duration, num, pct, price, titleCase } from "@/lib/format"
import type { EngineSummary } from "@/lib/queries"
import { cn } from "@/lib/utils"

const Dot = ({ ok }: { ok: boolean }) => <span className={cn("inline-block size-2 rounded-full", ok ? "bg-gain" : "bg-loss")} aria-hidden />

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
                <KV label="Activity">
                  {titleCase(s.cycle_state)}
                  {s.current_phase ? ` · ${s.current_phase}` : ""}
                  {s.current_task ? ` · ${s.current_task}` : ""}
                </KV>
                <KV label="Last heartbeat">{engine.heartbeatAgeS === null ? "—" : `${engine.heartbeatAgeS}s ago`}</KV>
                <KV label="Kill switch">{s.kill_switch ? <Badge variant="destructive">engaged</Badge> : "off"}</KV>
                <KV label="Up since">{formatDateTime(s.started_at)}</KV>
                <KV label="Version / host">
                  {s.version} / {s.instance}
                </KV>
                <KV label="Scheduler">{s.schedule.phase ? `${s.schedule.phase} due` : s.schedule.reason}</KV>
                <KV label="Last cycle">{s.last_cycle ? `${s.last_cycle.phase} ${s.last_cycle.status}, ${ago(s.last_cycle.at)}` : "—"}</KV>
                <KV label="Errors (1h)">{s.errors_last_hour}</KV>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Dot ok={s.broker.rest === "ok" && s.broker.trade_stream.state === "connected"} /> Alpaca (paper)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="REST API">{s.broker.rest}</KV>
                <KV label="Last OK request">{ago(s.broker.last_ok_at)}</KV>
                <KV label="Trade updates stream">{s.broker.trade_stream.state}</KV>
                <KV label="Market data stream">{s.broker.data_stream.state}</KV>
                <KV label="Streaming symbols">{s.broker.data_stream.symbols.length}</KV>
                <KV label="Options level">{s.broker.options_level ?? "—"}</KV>
                {[s.broker.last_error, s.broker.trade_stream.last_error, s.broker.data_stream.last_error].filter(Boolean).map((e, i) => (
                  <p key={i} className="text-loss mt-2 line-clamp-3 text-xs">
                    {e}
                  </p>
                ))}
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
                <CardTitle className="text-base">Market</CardTitle>
              </CardHeader>
              <CardContent>
                <KV label="Trading day">{s.market?.day ?? "—"}</KV>
                <KV label="Session">{s.market ? (s.market.is_open ? "open" : s.market.is_trading_day ? "closed" : "no session today") : "—"}</KV>
                <KV label="Hours">{s.market?.open && s.market.close ? `${formatDateTime(s.market.open)} – ${formatDateTime(s.market.close)}${s.market.early_close ? " (early close)" : ""}` : "—"}</KV>
                <KV label="Next open">{s.market?.next_open ? formatDateTime(s.market.next_open) : "—"}</KV>
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
              </CardContent>
            </Card>
          </div>

          <section>
            <SectionTitle>Live prices</SectionTitle>
            {s.quotes.length === 0 ? (
              <Empty>No live prices yet (the market data stream starts with the engine).</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.quotes.map((q) => (
                    <TableRow key={q.symbol}>
                      <TableCell className="font-mono text-sm">{q.symbol}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{price(q.price)}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{pct(q.change_pct)}</TableCell>
                      <TableCell className={cn("text-right font-mono text-sm tabular-nums", q.age_s > 120 && "text-muted-foreground")}>{q.age_s}s</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
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
                      <TableCell className="max-w-xs text-xs" title={[w.detail, w.last_error].filter(Boolean).join(" · ")}>
                        {w.detail && <p className="text-muted-foreground truncate">{w.detail}</p>}
                        {w.last_error && <p className="text-loss truncate">{w.last_error}</p>}
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
                <span className="text-muted-foreground w-36 shrink-0 font-mono text-xs">{formatDateTime(e.ts)}</span>
                <span className={e.level === "error" ? "text-loss" : ""}>{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
