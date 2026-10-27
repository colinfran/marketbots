import { ImageResponse } from "next/og"
import type { Site } from "./metadata"

/**
 * The 1200×630 share-card template for Open Graph / Twitter images, and the app icons, drawn
 * with the bot's mark (`Mark`: plain SVG, no hooks, so next/og can render it).
 */

export const OG_SIZE = { width: 1200, height: 630 }

/** apple-icon.tsx: 180×180 PNG. */
export const APPLE_ICON_SIZE = { width: 180, height: 180 }

type Mark = (props: { size: number; color: string }) => React.ReactNode

export const shareImages = ({ site, Mark }: { site: Pick<Site, "name" | "url" | "author">; Mark: Mark }) => {
  const host = site.url.replace(/^https?:\/\//, "")

  const ogCard = ({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) =>
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
            <Mark size={52} color="#0a0a0a" />
            <div style={{ fontSize: 34, fontWeight: 600 }}>{site.name}</div>
            <div style={{ marginLeft: "auto", fontSize: 24, color: "#525252" }}>{eyebrow}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ fontSize: title.length > 70 ? 52 : 64, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 28, color: "#525252", lineHeight: 1.35 }}>{subtitle}</div>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#525252" }}>
            <div>{host}</div>
            <div>{`by ${site.author.name} · colinfran.com`}</div>
          </div>
        </div>
      ),
      OG_SIZE,
    )

  /** Black mark on a white tile; `rounded` gives the tile soft corners (for favicons on any tab-bar color). */
  const appIcon = (size: number, { rounded = false } = {}) =>
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
          <Mark size={Math.round(size * (rounded ? 0.8 : 0.7))} color="#0a0a0a" />
        </div>
      ),
      { width: size, height: size },
    )

  return { ogCard, appIcon, appleIcon: () => appIcon(APPLE_ICON_SIZE.width) }
}
