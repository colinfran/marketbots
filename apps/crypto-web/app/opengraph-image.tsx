import { OG_SIZE, ogCard } from "@/lib/og"
import { site } from "@/lib/site"

export const alt = site.ogImage.alt
export const size = OG_SIZE
export const contentType = "image/png"

export default function Image() {
  return ogCard({
    eyebrow: "AI crypto trading · 24/7",
    title: "An AI that researches crypto on the web and X, then trades around the clock.",
    subtitle: "Grok decides, a risk engine checks every order, a Kraken paper wallet executes. Every trade is public.",
  })
}
