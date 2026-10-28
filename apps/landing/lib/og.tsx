import { shareImages } from "@mb/web-kit/og"
import { MarketbotsMark } from "@/components/marks"
import { site } from "./site"

export { OG_SIZE } from "@mb/web-kit/og"

/** Share cards and app icons (@mb/web-kit/og) with the Marketbots mark. */
export const { ogCard, appIcon, appleIcon } = shareImages({ site, Mark: MarketbotsMark })
