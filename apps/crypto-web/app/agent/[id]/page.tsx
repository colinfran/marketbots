import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import { EpisodeDetail } from "@mb/ui/agent"
import { PageHeader } from "@/components/bits"
import { getEpisode } from "@/lib/agent"
import { getViewer } from "@/lib/auth"
import { getSettings } from "@/lib/data"
import { dateTime } from "@/lib/format"
import { clip, pageMetadata } from "@/lib/site"

type Props = { params: Promise<{ id: string }> }

/** One fetch per request, shared by the metadata and the page; the thinking only for the owner, unless it is public. */
const load = cache(async (id: string) => {
  const [viewer, settings] = await Promise.all([getViewer(), getSettings()])
  return getEpisode(id, { thinking: viewer.owner || !!settings?.settings.agent?.public_thinking })
})

const about = (subject: string) => (subject === "OWNER" ? "the owner's question" : subject === "MARKET" ? "the market" : subject === "BOOK" ? "its book" : subject)

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const e = await load(id).catch(() => null)
  if (!e) return { title: "Episode not found", robots: { index: false } }
  return pageMetadata({ title: clip(`Agent episode: ${about(e.subject)} · ${dateTime(e.started_at)}`, 70), description: clip(e.reply ?? e.error ?? "An agent episode.", 160), path: `/agent/${id}`, type: "article", publishedTime: e.started_at })
}

export default async function EpisodePage({ params }: Props) {
  const e = await load((await params).id)
  if (!e) notFound()
  return (
    <div className="space-y-8">
      <PageHeader title={`Episode · ${about(e.subject)} · ${dateTime(e.started_at)}`} description={e.reply ?? e.error ?? "In progress…"} />
      <EpisodeDetail episode={e} />
    </div>
  )
}
