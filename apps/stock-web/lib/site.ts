import { pageMetadataFor } from "@mb/web-kit/metadata"

/** Site identity used for SEO metadata, structured data, the sitemap and share images. */
export const site = {
  name: "StockMarketBot",
  url: "https://stockmarketbot.app",
  title: "StockMarketBot: an AI stock and options trading bot powered by Grok",
  tagline: "An AI that reads the news and X in real time and trades stocks and options with a $10,000 paper account, in public, live.",
  description:
    "StockMarketBot is an autonomous AI trading experiment by Colin Franceschini. Grok researches the web and X (Twitter) in real time, then trades US stocks and defined-risk options throughout every market day with a $10,000 paper account. Every search, decision, risk check and trade streams live.",
  keywords: [
    "AI stock trading bot",
    "AI trading bot",
    "Grok trading bot",
    "xAI Grok",
    "AI day trading",
    "AI options trading",
    "paper trading",
    "algorithmic trading",
    "stock market AI",
    "AI stock picks",
    "LLM trading experiment",
    "autonomous trading agent",
    "Alpaca paper trading",
    "stock market sentiment",
    "X Twitter stock sentiment",
    "daily stock market report",
    "Colin Franceschini",
  ],
  author: {
    name: "Colin Franceschini",
    url: "https://colinfran.com",
  },
  /** Default share image (public/ogimage-stockmarketbot.png). Report pages generate their own. */
  ogImage: {
    url: "/ogimage-stockmarketbot.png",
    width: 2746,
    height: 1438,
    alt: "StockMarketBot, created by Colin Franceschini",
  },
} as const

export { clip, jsonLd } from "@mb/web-kit/metadata"

/** Full per-page metadata (@mb/web-kit/metadata), with this site's name, author and default share image. */
export const pageMetadata = pageMetadataFor(site)
