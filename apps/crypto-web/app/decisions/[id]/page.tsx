import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { cache } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@mb/ui/components/card"
import { WireItemRow } from "@mb/ui/wire"
import { Delta, KV, PageHeader, SectionTitle } from "@/components/bits"
import { DecisionCard } from "@/components/decision-card"
import { FillsTable, OrdersTable } from "@/components/tables"
import { getDecision, getWireItemsById } from "@/lib/data"
import { ago, dateTime, price, qty, titleCase } from "@/lib/format"
import { clip, jsonLd, pageMetadata, site } from "@/lib/site"

type Props = { params: Promise<{ id: string }> }

/** One fetch per request, shared by the metadata and the page. */
const loadDecision = cache(getDecision)

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const data = await loadDecision(id).catch(() => null)
  if (!data) return { title: "Decision not found", robots: { index: false } }
  const d = data.decision
  const title = `${d.symbol} ${titleCase(d.action)}: AI trade decision`
  return pageMetadata({
    title,
    description: clip(`${dateTime(d.created_at)}, conviction ${d.ai.conviction}/100. ${d.ai.thesis}`, 160),
    path: `/decisions/${id}`,
    type: "article",
    publishedTime: d.created_at.toISOString(),
    image: { ...site.ogImage, url: `/decisions/${id}/opengraph-image`, alt: title },
  })
}

export default async function DecisionPage({ params }: Props) {
  const data = await loadDecision((await params).id)
  if (!data) notFound()
  const { decision: d, orders, fills, position } = data
  const triggeredBy = d.trigger_kind === "event" && d.wire_item_ids?.length ? await getWireItemsById(d.wire_item_ids) : []
  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: clip(`${d.symbol} ${titleCase(d.action)}: ${d.ai.thesis}`, 110),
    description: d.ai.thesis,
    datePublished: d.created_at.toISOString(),
    dateModified: d.created_at.toISOString(),
    mainEntityOfPage: `${site.url}/decisions/${d._id}`,
    image: `${site.url}/decisions/${d._id}/opengraph-image`,
    author: { "@type": "Person", name: site.author.name, url: site.author.url },
    publisher: { "@type": "Person", name: site.author.name, url: site.author.url },
  }
  return (
    <div className="space-y-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(article)} />
      <PageHeader
        title={`${d.symbol} · ${d.action.replace("_", " ")}`}
        description={
          <>
            {dateTime(d.created_at)} ·{" "}
            <Link href={`/research/${d.cycle_id}`} className="hover:underline">
              view the full cycle and research memo
            </Link>
          </>
        }
      />
      {triggeredBy.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">Triggered by our news engine</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="divide-y">
              {triggeredBy.map((i) => (
                <WireItemRow key={i.id} item={i} summary="open" />
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      {d.trigger_kind === "seed" && <p className="text-muted-foreground text-sm">Part of the owner&apos;s one-time seed buy.</p>}
      <DecisionCard d={d} link={false} />
      {position && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How the thesis is doing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <KV label="Status">{titleCase(position.status)}</KV>
              <KV label="Entry">{price(position.avg_price)}</KV>
              <KV label={position.status === "open" ? "Mark" : "Exit reason"}>{position.status === "open" ? price(position.mark_price) : titleCase(position.exit_reason ?? "—")}</KV>
              <KV label={position.status === "open" ? "Unrealized" : "Realized"}>
                <Delta value={position.status === "open" ? position.qty * (position.mark_price ?? position.avg_price) - position.cost_basis_usd : position.realized_pnl_usd} />
              </KV>
            </div>
            <div>
              <KV label="Quantity">{qty(position.qty)}</KV>
              <KV label="Stop / target">
                {price(position.stop_price)} / {price(position.take_profit_price)}
              </KV>
              <KV label="Last reviewed">{ago(position.last_reviewed_at)}</KV>
              <KV label="Opened">{dateTime(position.opened_at)}</KV>
            </div>
          </CardContent>
        </Card>
      )}
      {orders.length > 0 && (
        <section>
          <SectionTitle>Orders</SectionTitle>
          <OrdersTable orders={orders} />
        </section>
      )}
      {fills.length > 0 && (
        <section>
          <SectionTitle>Fills</SectionTitle>
          <FillsTable fills={fills} />
        </section>
      )}
    </div>
  )
}
