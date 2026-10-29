import type { Metadata } from "next"
import { AgentLive, AgentMemory, AgentStatusCard, AskAgentForm, EpisodeTable, ShadowBook } from "@mb/ui/agent"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { StreamBadge } from "@mb/ui/live"
import { PageHeader, SectionTitle } from "@/components/bits"
import { agentStatusView, getAgentMemory, getEpisode, getEpisodes, getShadowBook } from "@/lib/agent"
import { getViewer } from "@/lib/auth"
import { getEngine, getSettings } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "The agent",
  description: "The local AI agent that wakes on news, the session and moves, looks things up step by step, and decides into its own shadow book: every episode, watch and simulated trade.",
  path: "/agent",
})

/** The agent (docs/plans/LOCAL-AI.md §11): what it is doing now, its shadow book, its memory, its episodes. */
export default async function AgentPage() {
  const [viewer, engine, settings, episodes, book, memory] = await Promise.all([getViewer(), getEngine(), getSettings(), getEpisodes(50), getShadowBook(), getAgentMemory()])
  const thinking = viewer.owner || !!settings.agent?.public_thinking
  const latest = episodes[0] ? await getEpisode(episodes[0].id, { thinking }) : null
  const status = agentStatusView(engine.status)
  return (
    <div className="space-y-8">
      <PageHeader
        title="The agent"
        description="A local AI model that runs beside the bot's scheduled cycles. Code watches prices, news, the session and its own watches all the time and wakes it when something matters; it looks things up one step at a time and decides. In shadow, its decisions fill in a simulated book at live prices and slippage, never at the broker, so its record can be compared with the bot's."
        action={<StreamBadge />}
      />
      <AgentStatusCard status={status} online={engine.online} />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Now</CardTitle>
            <CardDescription>The episode running now, or the last one: why it woke, each lookup, and what it decided.{thinking ? " Its thinking streams while it runs." : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentLive initial={latest} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Ask the agent</CardTitle>
            <CardDescription>{viewer.owner ? "A read-only episode: it looks things up and answers, and nothing it decides is acted on." : "The owner can ask it questions."}</CardDescription>
          </CardHeader>
          {viewer.owner && (
            <CardContent>
              <AskAgentForm disabled={!engine.online || status?.state === "off"} />
            </CardContent>
          )}
        </Card>
      </div>
      <section>
        <SectionTitle>Shadow book</SectionTitle>
        <ShadowBook account={status?.shadow ?? null} {...book} />
      </section>
      <section>
        <SectionTitle>Watches and notes</SectionTitle>
        <AgentMemory {...memory} />
      </section>
      <section>
        <SectionTitle>Episodes</SectionTitle>
        <EpisodeTable rows={episodes} />
      </section>
    </div>
  )
}
