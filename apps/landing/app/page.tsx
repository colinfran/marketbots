import { Badge } from "@mb/ui/components/badge"
import { Button } from "@mb/ui/components/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@mb/ui/components/card"
import { ArrowRightIcon, NewspaperIcon, RadioIcon, ShieldCheckIcon } from "lucide-react"
import { Fragment } from "react"
import { CryptoMark, StockMark } from "@/components/marks"

const BOTS = [
  {
    name: "CryptoMarketBot",
    url: "https://cryptomarketbot.app",
    Mark: CryptoMark,
    tagline: "Crypto, around the clock",
    summary: "Researches Bitcoin, Ethereum, Solana and other coins with live web and X search, then buys and sells 24/7 in a Kraken paper wallet at live Kraken prices.",
    facts: [
      ["Trades", "Kraken spot pairs"],
      ["Hours", "24/7"],
      ["Account", "Kraken paper wallet"],
    ],
  },
  {
    name: "StockMarketBot",
    url: "https://stockmarketbot.app",
    Mark: StockMark,
    tagline: "US stocks and options, every market day",
    summary: "Reads the news and X in real time, then trades US stocks and defined-risk options through every market day in an Alpaca paper account.",
    facts: [
      ["Trades", "US stocks, defined-risk options"],
      ["Hours", "US market days"],
      ["Account", "Alpaca paper account"],
    ],
  },
] as const

const STEPS = [
  { Icon: NewspaperIcon, title: "Research", text: "The engine watches about 150 news sources, and Grok searches the web and X in real time before it decides." },
  { Icon: ShieldCheckIcon, title: "Decide", text: "The AI proposes trades with a written thesis. Deterministic code sizes every order and a risk engine checks it before it is placed." },
  { Icon: RadioIcon, title: "Publish", text: "Every research memo, decision and trade streams live to the bot's public dashboard." },
]

export default function Home() {
  return (
    <>
      <section className="py-16 sm:py-24">
        <Badge variant="outline">Paper trading · no real money</Badge>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Two AI trading bots, trading in public.</h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg text-pretty">
          Marketbots is an experiment in autonomous trading. Grok researches the market and decides; deterministic code sizes and checks every order. One bot trades crypto around the
          clock, the other trades US stocks and options on market days, and you can watch both live.
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
            <CardContent className="flex flex-1 flex-col gap-4">
              <p>{summary}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                {facts.map(([term, value]) => (
                  <Fragment key={term}>
                    <dt className="text-muted-foreground">{term}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
              </dl>
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

      <section aria-labelledby="how" className="py-16 sm:py-24">
        <h2 id="how" className="text-2xl font-semibold tracking-tight">
          How they work
        </h2>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Each bot runs on its own always-on engine, with its own paper account, database and dashboard. Both follow the same loop.
        </p>
        <ol className="mt-8 grid gap-8 sm:grid-cols-3">
          {STEPS.map(({ Icon, title, text }, i) => (
            <li key={title} className="flex flex-col gap-2">
              <div className="bg-muted flex size-9 items-center justify-center rounded-lg">
                <Icon className="size-4" aria-hidden />
              </div>
              <h3 className="mt-1 font-medium">
                {i + 1}. {title}
              </h3>
              <p className="text-muted-foreground text-sm">{text}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}
