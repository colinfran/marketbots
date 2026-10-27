import type { CoreRankRow } from "@mb/stock-core/core-book"
import { Badge } from "@mb/ui/components/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { SymbolLink } from "@/components/bits"
import { pct, tone } from "@/lib/format"
import { cn } from "@/lib/utils"

const SOURCE_LABEL: Record<CoreRankRow["sources"][number], string> = { universe: "liquid", benchmark: "benchmark", theme: "theme", held: "held" }

/** Why a candidate has no score. */
export const unrankedReason = (r: CoreRankRow) => {
  if (r.sma200 === null) return "less than 200 sessions of history"
  if (r.price <= r.sma200) return "below its 200-day average"
  if (r.sma50 !== null && r.sma50 <= r.sma200) return "50-day average below the 200-day"
  return "less than a year of history"
}

function Pct({ value, signed = true }: { value: number | null; signed?: boolean }) {
  return <span className={cn("tabular-nums", signed && tone(value))}>{pct(value, { sign: signed, digits: 1 })}</span>
}

/** The day's candidates with their long-term numbers: ranked ones by score, the others with why they're not ranked. */
export function RankingTable({ rows, ranked }: { rows: CoreRankRow[]; ranked: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {ranked && <TableHead className="text-right">#</TableHead>}
          <TableHead>Symbol</TableHead>
          {ranked ? <TableHead className="text-right">Score</TableHead> : <TableHead>Not ranked because</TableHead>}
          <TableHead className="text-right">12-1 mo</TableHead>
          <TableHead className="text-right">6 mo</TableHead>
          <TableHead className="text-right">vs SPY 6 mo</TableHead>
          <TableHead className="text-right">vs SPY 12 mo</TableHead>
          <TableHead className="text-right">From 52w high</TableHead>
          <TableHead className="text-right">Volatility</TableHead>
          <TableHead className="text-right">Worst drawdown</TableHead>
          <TableHead>Why a candidate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.symbol}>
            {ranked && <TableCell className="text-muted-foreground text-right tabular-nums">{r.rank}</TableCell>}
            <TableCell>
              <SymbolLink symbol={r.symbol} />
              {r.name && <span className="text-muted-foreground block max-w-48 truncate text-xs">{r.name}</span>}
            </TableCell>
            {ranked ? <TableCell className="text-right font-medium tabular-nums">{r.score}</TableCell> : <TableCell className="text-muted-foreground text-xs">{unrankedReason(r)}</TableCell>}
            <TableCell className="text-right">
              <Pct value={r.return_12_1_pct} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.return_6m_pct} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.rel_spy_6m_pct} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.rel_spy_12m_pct} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.from_52w_high_pct} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.volatility_60d_pct} signed={false} />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.max_drawdown_1y_pct} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {r.sources
                  .filter((s) => s !== "theme")
                  .map((s) => (
                    <Badge key={s} variant="outline" className="font-normal">
                      {SOURCE_LABEL[s]}
                    </Badge>
                  ))}
                {r.themes.map((t) => (
                  <Badge key={t} variant="secondary" className="font-normal">
                    {t}
                  </Badge>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
