import { Badge } from "@mb/ui/components/badge"
import { Button } from "@mb/ui/components/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@mb/ui/components/card"
import { ArrowRightIcon } from "lucide-react"
import { CryptoMark, StockMark } from "@/components/marks"
import { Topology } from "@/components/topology"

const BOTS = [
  {
    name: "CryptoMarketBot",
    url: "https://cryptomarketbot.app",
    Mark: CryptoMark,
    tagline: "Crypto, around the clock",
    summary: "Follows the news and the market for Bitcoin, Ethereum, Solana and other coins, then trades 24/7 in a Kraken paper wallet at live prices.",
    facts: ["Kraken spot pairs", "24/7", "Kraken paper wallet"],
  },
  {
    name: "StockMarketBot",
    url: "https://stockmarketbot.app",
    Mark: StockMark,
    tagline: "US stocks and options, every market day",
    summary: "Reads the news as it breaks, then trades US stocks and defined-risk options through every market day in an Alpaca paper account.",
    facts: ["US stocks", "Defined-risk options", "Alpaca paper account"],
  },
] as const

export default function Home() {
  return (
    <div className="flex flex-col gap-6 py-6 sm:gap-8">
      <section>
        <Badge variant="outline">Paper trading · no real money</Badge>
        <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Two AI trading bots, trading in public.</h1>
        <p className="text-muted-foreground mt-3 max-w-2xl text-pretty">
          An AI researches the market and decides; deterministic code sizes and checks every order. One bot trades crypto around the clock, the other US stocks and options on market
          days, and you can watch both live.
        </p>
      </section>

      <section aria-label="The bots" className="grid gap-4 md:grid-cols-2">
        {BOTS.map(({ name, url, Mark, tagline, summary, facts }) => (
          <Card key={name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mark className="size-6" />
                {name}
              </CardTitle>
              <CardDescription>{tagline}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <p>{summary}</p>
              <ul className="flex flex-wrap gap-1.5" aria-label="At a glance">
                {facts.map((fact) => (
                  <li key={fact}>
                    <Badge variant="secondary">{fact}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter className="flex-wrap gap-x-4 gap-y-2">
              <Button asChild>
                <a href={url}>
                  Open {name}
                  <ArrowRightIcon data-icon="inline-end" />
                </a>
              </Button>
              <span className="text-muted-foreground ml-auto font-mono text-xs">{url.replace("https://", "")}</span>
            </CardFooter>
          </Card>
        ))}
      </section>

      <Topology />
    </div>
  )
}
