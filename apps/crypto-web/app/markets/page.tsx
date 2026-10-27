import type { Metadata } from "next"
import { LivePrice } from "@mb/ui/live"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { ActionBadge, Empty, PageHeader, SymbolLink } from "@/components/bits"
import { getEngine, getLatestDecisions } from "@/lib/data"
import { ago, num, pct, titleCase, tone } from "@/lib/format"
import { pageMetadata } from "@/lib/site"
import { cn } from "@/lib/utils"

export const metadata: Metadata = pageMetadata({
  title: "Crypto markets: live prices and signals",
  description: "Live Kraken prices, trend, RSI and volatility for every coin CryptoMarketBot watches, with the AI's latest decision on each.",
  path: "/markets",
})

const trend = (t: string | null | undefined) => (t === "up" ? "↑ up" : t === "down" ? "↓ down" : t === "flat" ? "→ flat" : "—")

export default async function MarketsPage() {
  const [engine, latest] = await Promise.all([getEngine(), getLatestDecisions()])
  const symbols = engine.status?.symbols ?? []
  return (
    <div>
      <PageHeader
        title="Markets"
        description="The Kraken spot universe the engine watches. Prices stream live from Kraken's WebSocket feed through the engine; indicators are computed in code each cycle."
      />
      {!symbols.length ? (
        <Empty>No market data yet: the engine hasn&apos;t reported in.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              <TableHead>Last (24h)</TableHead>
              <TableHead className="text-right">Spread</TableHead>
              <TableHead className="text-right">7d</TableHead>
              <TableHead className="text-right">30d</TableHead>
              <TableHead>4h / 1d trend</TableHead>
              <TableHead className="text-right">RSI 1h</TableHead>
              <TableHead className="text-right">30d vol</TableHead>
              <TableHead className="text-right">Volume vs avg</TableHead>
              <TableHead>Latest AI call</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {symbols.map((s) => {
              const f = s.features
              const d = latest[s.symbol]
              const spread = s.bid && s.ask ? ((s.ask - s.bid) / ((s.ask + s.bid) / 2)) * 10_000 : null
              return (
                <TableRow key={s.symbol}>
                  <TableCell>
                    <SymbolLink symbol={s.symbol} />
                  </TableCell>
                  <TableCell>
                    <LivePrice symbol={s.symbol} initial={s.last} initialChange={s.change_pct} className="font-mono text-sm" />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{spread === null ? "—" : `${num(spread, 1)} bps`}</TableCell>
                  <TableCell className={cn("text-right font-mono text-sm tabular-nums", tone(f?.ret_7d_pct))}>{pct(f?.ret_7d_pct)}</TableCell>
                  <TableCell className={cn("text-right font-mono text-sm tabular-nums", tone(f?.ret_30d_pct))}>{pct(f?.ret_30d_pct)}</TableCell>
                  <TableCell className="text-sm">
                    {trend(f?.trend_4h)} / {trend(f?.trend_1d)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{num(f?.rsi14_1h, 0)}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{f?.vol_30d_pct === null || f?.vol_30d_pct === undefined ? "—" : `${num(f.vol_30d_pct, 0)}%`}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{f?.volume_ratio_24h === null || f?.volume_ratio_24h === undefined ? "—" : `${num(f.volume_ratio_24h, 2)}×`}</TableCell>
                  <TableCell className="text-sm">{d ? <span className="inline-flex items-center gap-1.5"><ActionBadge action={d.action} /> <span className="text-muted-foreground text-xs">{ago(d.at)}</span></span> : <span className="text-muted-foreground text-xs">none yet</span>}</TableCell>
                  <TableCell className={cn("text-xs", s.stale ? "text-loss" : "text-muted-foreground")}>{s.stale ? "stale" : titleCase("live")}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
