import type { Metadata } from "next"
import { SYMBOL_PATTERN, baseAsset } from "@mb/crypto-core/venues"
import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { LivePrice } from "@mb/ui/live"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, KV, PageHeader, SectionTitle } from "@/components/bits"
import { PriceChart, type ChartLevel } from "@/components/charts"
import { DecisionsTable, FillsTable } from "@/components/tables"
import { getAccount, getDecisions, getEngine, getFills, getWireItems } from "@/lib/data"
import { ago, num, pct, price, qty, slugSymbol, symbolSlug, titleCase } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

type Props = { params: Promise<{ pair: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const symbol = slugSymbol((await params).pair)
  if (!SYMBOL_PATTERN.test(symbol)) return { title: "Market not found", robots: { index: false } }
  return pageMetadata({
    title: `${symbol} price, news and AI trades`,
    description: `Live ${symbol} price from Kraken, the indicators the bot computes, the news our feeds saw, and every AI decision and paper trade on ${baseAsset(symbol)}.`,
    path: `/markets/${symbolSlug(symbol)}`,
  })
}

export default async function PairPage({ params }: Props) {
  const symbol = slugSymbol((await params).pair)
  if (!SYMBOL_PATTERN.test(symbol)) notFound()
  const [engine, account, fills, decisions, news] = await Promise.all([getEngine(), getAccount(), getFills(200, symbol), getDecisions({ symbol, limit: 30 }), getWireItems({ symbol, hours: 72, limit: 10 })])
  const health = engine.status?.symbols.find((s) => s.symbol === symbol)
  const position = account?.positions.find((p) => p.symbol === symbol) ?? null
  const levels: ChartLevel[] = position
    ? [
        ...(position.stop_price ? [{ label: "stop", value: position.stop_price }] : []),
        ...(position.take_profit_price ? [{ label: "target", value: position.take_profit_price }] : []),
        { label: "entry", value: position.avg_price },
      ]
    : []
  const f = health?.features

  return (
    <div className="space-y-8">
      <PageHeader
        title={symbol}
        description={<LivePrice symbol={symbol} initial={health?.last ?? null} initialChange={health?.change_pct ?? null} className="text-foreground text-lg" />}
      />
      <Card>
        <CardContent>
          <PriceChart symbol={symbol} fills={fills.map((x) => ({ at: x.at.toISOString(), side: x.side, price: x.price, qty: x.qty }))} levels={levels} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Position</CardTitle>
          </CardHeader>
          <CardContent>
            {position ? (
              <div>
                <KV label="Quantity">{qty(position.qty)}</KV>
                <KV label="Entry">{price(position.avg_price)}</KV>
                <KV label="Unrealized">
                  <Delta value={position.qty * (position.mark_price ?? position.avg_price) - position.cost_basis_usd} />
                </KV>
                <KV label="Stop / target">
                  {price(position.stop_price)} / {price(position.take_profit_price)}
                </KV>
                <KV label="Strategy">{position.strategy_id ? titleCase(position.strategy_id) : "—"}</KV>
                <KV label="Opened">{ago(position.opened_at)}</KV>
                {position.thesis && <p className="text-muted-foreground mt-3 text-sm">{position.thesis}</p>}
                {position.invalidation && <p className="mt-2 text-sm"><span className="font-medium">Invalidation:</span> <span className="text-muted-foreground">{position.invalidation}</span></p>}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Not held.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Indicators</CardTitle>
          </CardHeader>
          <CardContent>
            {f ? (
              <div>
                <KV label="24h / 7d / 30d">
                  {pct(f.ret_24h_pct)} / {pct(f.ret_7d_pct)} / {pct(f.ret_30d_pct)}
                </KV>
                <KV label="Trend 4h / 1d">
                  {f.trend_4h ?? "—"} / {f.trend_1d ?? "—"}
                </KV>
                <KV label="RSI (1h)">{num(f.rsi14_1h, 1)}</KV>
                <KV label="ATR (1h)">{f.atr_pct_1h === null ? "—" : `${num(f.atr_pct_1h, 2)}%`}</KV>
                <KV label="30d realized vol">{f.vol_30d_pct === null ? "—" : `${num(f.vol_30d_pct, 0)}%`}</KV>
                <KV label="Volume vs 30d avg">{f.volume_ratio_24h === null ? "—" : `${num(f.volume_ratio_24h, 2)}×`}</KV>
                <p className="text-muted-foreground mt-2 text-xs">As of {ago(f.as_of)}</p>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Computed when the next minute&apos;s bars arrive.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">News in the last 72 hours</CardTitle>
          </CardHeader>
          <CardContent>
            {news.length ? (
              <ul className="space-y-1.5 text-sm">
                {news.map((n) => (
                  <li key={n.id}>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
                        {n.title}
                      </a>
                    ) : (
                      n.title
                    )}
                    <span className="text-muted-foreground ml-1 inline-flex items-center gap-0.5 text-xs">
                      {n.domain ?? n.source} · severity {n.severity} · {ago(n.first_seen_at)} {n.url && <ExternalLinkIcon className="size-3" aria-hidden />}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Our feeds saw nothing about {symbol} in the last 72 hours.</p>
            )}
            <Link prefetch href={`/news?symbol=${encodeURIComponent(symbol)}`} className="text-muted-foreground mt-3 inline-block text-xs hover:underline">
              All the news on {symbol}
            </Link>
          </CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle>AI decisions on {symbol}</SectionTitle>
        <DecisionsTable decisions={decisions} />
      </section>
      <section>
        <SectionTitle>Paper fills</SectionTitle>
        {fills.length ? <FillsTable fills={fills} /> : <Empty>No trades in {symbol} yet.</Empty>}
      </section>
    </div>
  )
}
