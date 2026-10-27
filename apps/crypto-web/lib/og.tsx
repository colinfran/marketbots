import { ImageResponse } from "next/og"
import { BotMark } from "@/components/bot-mark"
import { site } from "./site"

/** Shared 1200×630 share-card template for Open Graph / Twitter images, plus the app icon. */

export const OG_SIZE = { width: 1200, height: 630 }

const host = site.url.replace(/^https?:\/\//, "")

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
          <div>{host}</div>
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
