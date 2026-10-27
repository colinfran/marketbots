import { pageMetadataFor } from "@mb/web-kit/metadata"
import { env } from "./env"

/**
 * Canonical origin (SITE_URL, else the Vercel production domain, else local dev). Canonical URLs,
 * the sitemap and share images all hang off it, so preview URLs never become the indexed address.
 */
const origin = () => (env.siteUrl() ?? "http://localhost:3000").replace(/\/+$/, "")

/** Site identity used for SEO metadata, structured data, the sitemap and share images. */
export const site = {
  name: "CryptoMarketBot",
  url: origin(),
  title: "CryptoMarketBot: an AI crypto trading bot powered by Grok",
  tagline: "An AI that researches the crypto market with live web and X search, then trades a Kraken paper wallet 24/7, in public.",
  description:
    "CryptoMarketBot is an autonomous AI crypto-trading experiment by Colin Franceschini. Grok researches Bitcoin, Ethereum, Solana and other coins with live web and X (Twitter) search, then buys and sells around the clock in a Kraken paper wallet while a risk engine checks every order. Every research memo, decision and trade is published live.",
  keywords: [
    "AI crypto trading bot",
    "crypto trading bot",
    "AI trading bot",
    "Grok trading bot",
    "xAI Grok",
    "Bitcoin trading bot",
    "Ethereum trading bot",
    "AI crypto trading",
    "crypto paper trading",
    "Kraken paper trading",
    "algorithmic crypto trading",
    "autonomous trading agent",
    "LLM trading experiment",
    "crypto market sentiment",
    "X Twitter crypto sentiment",
    "24/7 crypto trading",
    "Colin Franceschini",
  ],
  author: {
    name: "Colin Franceschini",
    url: "https://colinfran.com",
  },
  /** Default share image, rendered by app/opengraph-image.tsx. Decision pages generate their own. */
  ogImage: {
    url: "/opengraph-image",
    width: 1200,
    height: 630,
    alt: "CryptoMarketBot, created by Colin Franceschini",
  },
} as const

export { clip, jsonLd } from "@mb/web-kit/metadata"

/** Full per-page metadata (@mb/web-kit/metadata), with this site's name, author and default share image. */
export const pageMetadata = pageMetadataFor(site)
