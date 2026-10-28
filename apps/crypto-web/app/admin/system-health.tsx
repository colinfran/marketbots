import type { EngineEvent } from "@mb/crypto-core/events"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { AiHealthCard, EngineHealthCard, HealthDot, ProblemsSection, ServerHealthCard, StreamHealthCard, WireSourcesSummary } from "@mb/ui/system-health"
import { Empty, KV, SectionTitle } from "@/components/bits"
import type { EngineSummary } from "@/lib/data"
import { ago, dateTime, num, price, titleCase } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Health of the engine on the trading server and everything it depends on (@mb/ui/system-health), with Kraken's cards. */
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
              dateTime={dateTime}
              activity={
                <>
                  {titleCase(s.cycle_state)}
                  {s.current_task ? ` · ${s.current_task}` : ""}
                </>
              }
              lastCycle={s.last_cycle ? `${s.last_cycle.status}, ${ago(s.last_cycle.at)}` : "—"}
            />
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HealthDot ok={s.kraken.ws === "connected" && s.kraken.rest === "ok"} /> Kraken market data
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
                  <HealthDot ok={s.paper_wallet.ok && (s.reconciliation?.ok ?? false)} /> Paper wallet (Kraken CLI)
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
            <AiHealthCard ai={s.ai} />
            <ServerHealthCard system={s.system} />
            <StreamHealthCard status={s}>
              <KV label="Next scheduled scan">{dateTime(s.next_cycle_at)}</KV>
            </StreamHealthCard>
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

          {s.wire && <WireSourcesSummary wire={s.wire} />}
        </>
      )}

      <ProblemsSection problems={problems} dateTime={dateTime} timeClassName="w-28" />
    </div>
  )
}
