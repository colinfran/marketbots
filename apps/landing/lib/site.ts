import type { Site } from "@mb/web-kit/metadata"

/** Site identity used for SEO metadata, structured data, the sitemap and share images. */
export const site = {
  name: "Marketbots",
  url: "https://marketbots.vercel.app",
  title: "Marketbots: two AI trading bots, trading in public",
  tagline: "Two autonomous AI paper-trading bots, one for US stocks and options and one for crypto. Every decision and trade is published live.",
  description:
    "Marketbots is an autonomous AI trading experiment by Colin Franceschini. StockMarketBot trades US stocks and defined-risk options on market days in an Alpaca paper account; CryptoMarketBot trades crypto 24/7 in a Kraken paper wallet. An AI researches and decides, a risk engine checks every order, and every trade is published live.",
  keywords: [
    "AI trading bot",
    "AI crypto trading bot",
    "AI stock trading bot",
    "paper trading",
    "algorithmic trading",
    "autonomous trading agent",
    "LLM trading experiment",
    "CryptoMarketBot",
    "StockMarketBot",
    "Colin Franceschini",
  ],
  author: {
    name: "Colin Franceschini",
    url: "https://colinfran.com",
  },
  /** Default share image, rendered by app/opengraph-image.tsx. */
  ogImage: {
    url: "/opengraph-image",
    width: 1200,
    height: 630,
    alt: "Marketbots, created by Colin Franceschini",
  },
} as const satisfies Site

export { jsonLd } from "@mb/web-kit/metadata"
