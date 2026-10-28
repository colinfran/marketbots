import { OG_SIZE, ogCard } from "@/lib/og"
import { site } from "@/lib/site"

export const alt = site.ogImage.alt
export const size = OG_SIZE
export const contentType = "image/png"

export default function Image() {
  return ogCard({
    eyebrow: "AI paper trading",
    title: "Two AI trading bots, trading in public.",
    subtitle: "CryptoMarketBot trades crypto 24/7. StockMarketBot trades US stocks and options. Grok decides, a risk engine checks every order.",
  })
}
