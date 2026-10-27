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

type ShareImage = { url: string; width: number; height: number; alt: string }

/** Serializes JSON-LD safely for an inline <script> tag. */
export const jsonLd = (data: unknown) => ({ __html: JSON.stringify(data).replace(/</g, "\\u003c") })

/** Trims text to a meta-tag length on a word boundary. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * Full per-page metadata. Next merges `openGraph`/`twitter` shallowly, and a page's own
 * `openGraph.images` beats a file-based image, so each page sets the whole block (plus its own
 * canonical URL and image) rather than relying on the root layout.
 */
export const pageMetadata = ({
  title,
  description,
  path,
  type = "website",
  publishedTime,
  image = site.ogImage,
}: {
  title: string
  description: string
  path: string
  type?: "website" | "article"
  publishedTime?: string
  image?: ShareImage
}) => {
  const shareTitle = title.includes(site.name) ? title : `${title} · ${site.name}`
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type,
      url: path,
      siteName: site.name,
      title: shareTitle,
      description,
      locale: "en_US",
      images: [image],
      ...(type === "article" ? { publishedTime, authors: [site.author.url] } : {}),
    },
    twitter: { card: "summary_large_image" as const, title: shareTitle, description, images: [image] },
  }
}
