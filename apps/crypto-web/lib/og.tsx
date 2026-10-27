import { shareImages } from "@mb/web-kit/og"
import { BotMark } from "@/components/bot-mark"
import { site } from "./site"

export { OG_SIZE } from "@mb/web-kit/og"

/** Share cards and app icons (@mb/web-kit/og) with crypto's robot mark. */
export const { ogCard, appIcon, appleIcon } = shareImages({ site, Mark: BotMark })
