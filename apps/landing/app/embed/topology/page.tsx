import type { Metadata } from "next"
import { EmbedFrame, THEME_SCRIPT } from "@/components/embed-frame"
import { Topology } from "@/components/topology"

export const metadata: Metadata = {
  title: "How Marketbots works",
  robots: { index: false, follow: false },
}

/**
 * The homepage's "How they work" animation alone, on a transparent page, for colinfran.com's blog
 * to frame. next.config.ts lets only that site (and localhost, for its dev server) frame /embed/.
 */
export default function TopologyEmbed() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <style>{"html, body { background: transparent; }"}</style>
      <EmbedFrame>
        <Topology embedded />
      </EmbedFrame>
    </>
  )
}
