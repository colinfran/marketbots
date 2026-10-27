import { ImageResponse } from "next/og"
import { site } from "./site"

/** Shared 1200×630 share-card template for Open Graph / Twitter images. */

export const OG_SIZE = { width: 1200, height: 630 }

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

export const ogCard = ({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) =>
  new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "#ffffff",
          color: "#0a0a0a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <BotMark size={52} color="#0a0a0a" />
          <div style={{ fontSize: 34, fontWeight: 600 }}>{site.name}</div>
          <div style={{ marginLeft: "auto", fontSize: 24, color: "#525252" }}>{eyebrow}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: title.length > 70 ? 52 : 64, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 28, color: "#525252", lineHeight: 1.35 }}>{subtitle}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#525252" }}>
          <div>stockmarketbot.app</div>
          <div>{`by ${site.author.name} · colinfran.com`}</div>
        </div>
      </div>
    ),
    OG_SIZE,
  )

/** Black bot on a white tile; `rounded` gives the tile soft corners (for favicons on any tab-bar color). */
export const appIcon = (size: number, { rounded = false } = {}) =>
  new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: rounded ? Math.round(size * 0.2) : 0,
        }}
      >
        <BotMark size={Math.round(size * (rounded ? 0.8 : 0.7))} color="#0a0a0a" />
      </div>
    ),
    { width: size, height: size },
  )
