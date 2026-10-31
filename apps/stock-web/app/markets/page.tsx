import { SETUP_INFO, type Setup } from "@mb/stock-core/setups"
import type { Metadata } from "next"
import Link from "next/link"
import { LivePrice } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { ActionBadge, Empty, PageHeader, SymbolLink } from "@/components/bits"
import { getAgentMemory } from "@/lib/agent"
import { ago, decisionHref, price, titleCase } from "@/lib/format"
import { getEngine, getLatestDecisions, getLiveAccount, getSettings } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Stock market board: live prices, holdings and the AI's watches",
  description: "Live prices for every stock StockMarketBot holds or its AI agent is watching, the index and sector ETFs it reads the tape with, and the agent's latest decision on each.",
  path: "/markets",
})

const ROLES = ["Held", "Options", "Watched", "Benchmark"] as const
type Role = (typeof ROLES)[number]

export default async function MarketsPage() {
  const [engine, live, settings, latest, memory] = await Promise.all([getEngine(), getLiveAccount(), getSettings(), getLatestDecisions(), getAgentMemory()])
  const status = engine.status
  const quotes = new Map((status?.quotes ?? []).map((q) => [q.symbol, q]))
  const held = new Map((live?.positions ?? []).map((p) => [p.symbol, p]))
  // The agent's watches name what it is waiting for on a stock.
  const watches = new Map<string, string[]>()
  for (const w of memory.watches) if (w.symbol) watches.set(w.symbol, [...(watches.get(w.symbol) ?? []), w.what])
  const roles = new Map<string, Set<Role>>()
  const tag = (symbol: string, role: Role) => roles.set(symbol, (roles.get(symbol) ?? new Set()).add(role))
  for (const s of held.keys()) tag(s, "Held")
  for (const o of live?.options ?? []) tag(o.underlying, "Options")
  for (const s of watches.keys()) tag(s, "Watched")
  for (const s of settings.universe.benchmarks) tag(s, "Benchmark")
  // Anything else the engine streams (e.g. a symbol the owner asked about) still gets a row.
  for (const s of quotes.keys()) if (!roles.has(s)) roles.set(s, new Set())
  const rank = (s: string) => Math.min(...[...(roles.get(s) ?? [])].map((r) => ROLES.indexOf(r)), ROLES.length)
  const symbols = [...roles.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))

  return (
    <div>
      <PageHeader
        title="Markets"
        description="Every stock the bot holds or its agent is watching, plus the index and sector ETFs it reads the tape with. Prices stream live from Alpaca through the engine."
      />
      {!symbols.length ? (
        <Empty>No market data yet: the engine hasn&apos;t reported in.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Last (today)</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Setup</TableHead>
                <TableHead className="min-w-72">Thesis or watch</TableHead>
                <TableHead className="text-right">Stop / target</TableHead>
                <TableHead>Latest AI call</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {symbols.map((symbol) => {
                const q = quotes.get(symbol)
                const plan = held.get(symbol)?.plan
                const d = latest[symbol]
                const href = d ? decisionHref(d) : null
                return (
                  <TableRow key={symbol} className="align-top">
                    <TableCell>
                      <SymbolLink symbol={symbol} />
                    </TableCell>
                    <TableCell>
                      <LivePrice symbol={symbol} initial={q?.price ?? held.get(symbol)?.price ?? null} initialChange={q?.change_pct ?? null} className="font-mono text-sm" />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {[...(roles.get(symbol) ?? [])].map((r) => (
                          <Badge key={r} variant={r === "Benchmark" ? "outline" : "secondary"}>
                            {r}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{plan?.setup ? (SETUP_INFO[plan.setup as Setup]?.name ?? titleCase(plan.setup)) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-normal">{plan ? plan.thesis : (watches.get(symbol)?.join("; ") ?? "—")}</TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{plan ? `${price(plan.stop_loss)} / ${price(plan.take_profit)}` : "—"}</TableCell>
                    <TableCell className="text-sm">
                      {d ? (
                        href ? (
                          <Link prefetch href={href} className="inline-flex items-center gap-1.5 hover:underline">
                            <ActionBadge action={d.action} /> <span className="text-muted-foreground text-xs">{ago(d.at)}</span>
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <ActionBadge action={d.action} /> <span className="text-muted-foreground text-xs">{ago(d.at)}</span>
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground text-xs">none yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{q && status ? ago(status.at.getTime() - q.age_s * 1000) : "not streaming"}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
