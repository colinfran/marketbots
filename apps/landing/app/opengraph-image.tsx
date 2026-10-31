import { OG_SIZE, ogCard } from "@/lib/og"
import { site } from "@/lib/site"

export const alt = site.ogImage.alt
export const size = OG_SIZE
export const contentType = "image/png"

export default function Image() {
  return ogCard({
    eyebrow: "AI paper trading",
    title: "Two AI trading bots, trading in public.",
    subtitle: "StockMarketBot trades US stocks and options. CryptoMarketBot trades crypto 24/7. An AI decides, a risk engine checks every order.",
  })
}
