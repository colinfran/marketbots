import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, CurrentWork } from "@mb/ui/live"
import { Button } from "@mb/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { LiveWireList, SourceHealthStrip, TriggerList } from "@mb/ui/wire"
import { PageHeader, SectionTitle } from "@/components/bits"
import { CyclesTable, DecisionsTable } from "@/components/tables"
import { getCycles, getDecisions, getEngine, getSettings, getWireFacets, getWireItems, getWireTriggers } from "@/lib/data"
import { titleCase } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "AI research & decisions",
  description: "How Grok researches crypto with live web and X search, what our own news engine sees, and the evidence and reasoning behind every buy, hold, reduce or close decision.",
  path: "/research",
})

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const SEVERITIES = [30, 55, 70, 85]

export default async function ResearchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined)
  const filter = { symbol: one("symbol"), category: one("category"), source: one("source"), minSeverity: one("min") ? Number(one("min")) || undefined : undefined }
  const filtered = Object.values(filter).some((v) => v !== undefined)
  const [cycles, decisions, items, triggers, facets, engine, settingsDoc] = await Promise.all([
    getCycles(40),
    getDecisions({ limit: 60 }),
    getWireItems({ ...filter, limit: 150 }),
    getWireTriggers(40),
    getWireFacets(),
    getEngine(),
    getSettings(),
  ])
  const parsed = settingsSchema.safeParse(settingsDoc?.settings)
  const universe = (parsed.success ? parsed.data : DEFAULT_SETTINGS).universe.kraken_symbols
  const wire = engine.status?.wire ?? null
  const tab = one("tab") === "ours" || filtered ? "ours" : "ai"

  return (
    <div className="space-y-8">
      <PageHeader
        title="AI research & decisions"
        description="Two kinds of research feed every decision. AI research: Grok searches the web and X live. Our research: the bot's own news engine reads news outlets, regulators, exchanges, calendars and its own market data around the clock, and stamps each item with when it first saw it. The risk engine then approves, resizes or rejects every proposal."
      />
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="ai">AI research</TabsTrigger>
          <TabsTrigger value="ours">Our research</TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="mt-4 space-y-8">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardContent className="space-y-4">
                <h2 className="text-sm font-semibold">Right now</h2>
                <CurrentWork />
              </CardContent>
            </Card>
            <Card className="py-3 lg:col-span-2">
              <CardContent className="px-3">
                <ActivityFeed limit={30} className="max-h-80" />
              </CardContent>
            </Card>
          </div>
          <section>
            <SectionTitle>Cycles</SectionTitle>
            <CyclesTable cycles={cycles} />
          </section>
          <section>
            <SectionTitle>Recent decisions (including no-trades)</SectionTitle>
            <DecisionsTable decisions={decisions} />
          </section>
        </TabsContent>

        <TabsContent value="ours" className="mt-4 space-y-6">
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

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="lg:col-span-2">
              <SectionTitle>What our feeds saw (last 72 h)</SectionTitle>
              <form method="get" className="mb-3 flex flex-wrap items-end gap-2 text-sm">
                <input type="hidden" name="tab" value="ours" />
                <Select name="symbol" label="Symbol" value={filter.symbol} options={universe} />
                <Select name="category" label="Category" value={filter.category} options={facets.categories} format={titleCase} />
                <Select name="source" label="Source" value={filter.source} options={facets.sources} />
                <Select name="min" label="Min severity" value={filter.minSeverity ? String(filter.minSeverity) : undefined} options={SEVERITIES.map(String)} />
                <Button type="submit" size="sm" variant="outline">
                  Filter
                </Button>
                {filtered && (
                  <Link href="/research?tab=ours" className="text-muted-foreground text-xs underline underline-offset-2">
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
        </TabsContent>
      </Tabs>
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
