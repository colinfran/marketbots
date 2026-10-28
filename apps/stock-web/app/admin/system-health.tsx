import type { EngineEvent } from "@mb/stock-core/events"
import { formatDateTime } from "@mb/stock-core/time"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { AiHealthCard, EngineHealthCard, HealthDot, HistoryHealthCard, ProblemsSection, ServerHealthCard, StreamHealthCard, WireSourcesSummary } from "@mb/ui/system-health"
import { Empty, KV, SectionTitle } from "@/components/bits"
import { ago, pct, price, titleCase } from "@/lib/format"
import type { EngineSummary } from "@/lib/queries"
import { cn } from "@/lib/utils"

/** Health of the engine on the trading server and everything it depends on (@mb/ui/system-health), with Alpaca's cards. */
export function SystemHealth({ engine, problems }: { engine: EngineSummary; problems: EngineEvent[] }) {
  const s = engine.status
  return (
    <div className="space-y-8">
      {!s ? (
        <Empty>The engine has never reported in. Check that the Docker container is running and can reach MongoDB.</Empty>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <EngineHealthCard
              engine={{ ...engine, status: s }}
              dateTime={formatDateTime}
              activity={
                <>
                  {titleCase(s.cycle_state)}
                  {s.current_phase ? ` · ${s.current_phase}` : ""}
                  {s.current_task ? ` · ${s.current_task}` : ""}
                </>
              }
              lastCycle={s.last_cycle ? `${s.last_cycle.phase} ${s.last_cycle.status}, ${ago(s.last_cycle.at)}` : "—"}
            >
              <KV label="Scheduler">{s.schedule.phase ? `${s.schedule.phase} due` : s.schedule.reason}</KV>
            </EngineHealthCard>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HealthDot ok={s.broker.rest === "ok" && s.broker.trade_stream.state === "connected"} /> Alpaca (paper)
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
            <AiHealthCard ai={s.ai} />
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
            <ServerHealthCard system={s.system} />
            {s.history && <HistoryHealthCard history={s.history} />}
            <StreamHealthCard status={s} />
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

          {s.wire && <WireSourcesSummary wire={s.wire} />}
        </>
      )}

      <ProblemsSection problems={problems} dateTime={formatDateTime} timeClassName="w-36" />
    </div>
  )
}
