import { shareImages } from "@mb/web-kit/og"
import { site } from "./site"

export { OG_SIZE } from "@mb/web-kit/og"

/** lucide's Bot (the header's icon) as plain SVG, so next/og can draw it. */
function BotMark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}

/** Share cards and app icons (@mb/web-kit/og) with stock's bot mark. */
export const { ogCard, appIcon, appleIcon } = shareImages({ site, Mark: BotMark })
