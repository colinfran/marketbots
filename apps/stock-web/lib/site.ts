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

/** Serializes JSON-LD safely for an inline <script> tag. */
export const jsonLd = (data: unknown) => ({ __html: JSON.stringify(data).replace(/</g, "\\u003c") })

/**
 * Full per-page metadata. Next merges `openGraph`/`twitter` shallowly, so each page sets the
 * whole block (plus its own canonical URL) rather than relying on the root layout.
 */
export const pageMetadata = ({
  title,
  description,
  path,
  type = "website",
  publishedTime,
}: {
  title: string
  description: string
  path: string
  type?: "website" | "article"
  publishedTime?: string
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
      images: [site.ogImage],
      ...(type === "article" ? { publishedTime, authors: [site.author.url] } : {}),
    },
    twitter: { card: "summary_large_image" as const, title: shareTitle, description, images: [site.ogImage] },
  }
}
