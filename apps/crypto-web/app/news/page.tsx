import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@mb/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { TableCell } from "@mb/ui/components/table"
import { WireSourcesSection } from "@mb/ui/system-health"
import { LiveWireList, SourceHealthStrip, TriggerList } from "@mb/ui/wire"
import { PageHeader, SectionTitle } from "@/components/bits"
import { getViewer } from "@/lib/auth"
import { getEngine, getSettings, getWireFacets, getWireItems, getWireTriggers } from "@/lib/data"
import { titleCase } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Crypto news engine",
  description: "What CryptoMarketBot's own news engine sees around the clock: news outlets, regulators, exchanges, calendars and its own market data, and the triggers that start a focused AI cycle.",
  path: "/news",
})

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const SEVERITIES = [30, 55, 70, 85]

export default async function NewsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined)
  const filter = { symbol: one("symbol"), category: one("category"), source: one("source"), minSeverity: one("min") ? Number(one("min")) || undefined : undefined }
  const filtered = Object.values(filter).some((v) => v !== undefined)
  const [viewer, items, triggers, facets, engine, settingsDoc] = await Promise.all([getViewer(), getWireItems({ ...filter, limit: 150 }), getWireTriggers(40), getWireFacets(), getEngine(), getSettings()])
  const parsed = settingsSchema.safeParse(settingsDoc?.settings)
  const universe = (parsed.success ? parsed.data : DEFAULT_SETTINGS).universe.kraken_symbols
  const wire = engine.status?.wire ?? null

  return (
    <div className="space-y-8">
      <PageHeader
        title="News"
        description="The bot's own news engine reads news outlets, regulators, exchanges, calendars and its own market data around the clock, and stamps each item with when it first saw it. What it finds feeds every AI decision; what's out of the ordinary starts a focused cycle."
      />
      {/* The owner sees every source with its errors; everyone else, one dot per source. */}
      {wire && viewer.owner ? (
        <WireSourcesSection
          wire={wire}
          note={(w) => (
            <TableCell className="text-muted-foreground max-w-xs truncate text-xs" title={w.last_error ?? ""}>
              {w.last_error ?? ""}
            </TableCell>
          )}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">News engine</CardTitle>
            <CardDescription>
              {wire ? `Mode ${wire.mode} · ${wire.items_last_hour} items in the last hour · ${wire.triggers_today} triggers today` : "The engine hasn't reported news-engine health yet."}
            </CardDescription>
          </CardHeader>
          {wire && (
            <CardContent>
              <SourceHealthStrip sources={wire.sources} />
            </CardContent>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <SectionTitle>What our feeds saw (last 72 h)</SectionTitle>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2 text-sm">
            <Select name="symbol" label="Symbol" value={filter.symbol} options={universe} />
            <Select name="category" label="Category" value={filter.category} options={facets.categories} format={titleCase} />
            <Select name="source" label="Source" value={filter.source} options={facets.sources} />
            <Select name="min" label="Min severity" value={filter.minSeverity ? String(filter.minSeverity) : undefined} options={SEVERITIES.map(String)} />
            <Button type="submit" size="sm" variant="outline">
              Filter
            </Button>
            {filtered && (
              <Link href="/news" className="text-muted-foreground text-xs underline underline-offset-2">
                Clear
              </Link>
            )}
          </form>
          <LiveWireList initial={items} filter={filter} />
        </section>
        <section>
          <SectionTitle>Triggers</SectionTitle>
          <p className="text-muted-foreground mb-2 text-xs">When an item is out of the ordinary, the engine starts a focused cycle. Suppressed triggers show why they were held back.</p>
          <TriggerList triggers={triggers} />
        </section>
      </div>
    </div>
  )
}

function Select({ name, label, value, options, format = (v: string) => v }: { name: string; label: string; value?: string; options: string[]; format?: (v: string) => string }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="bg-background h-8 rounded-md border px-2 text-sm">
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {format(o)}
          </option>
        ))}
      </select>
    </label>
  )
}
