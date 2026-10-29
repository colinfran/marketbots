import "server-only"
import { createAgentQueries } from "@mb/web-kit/agent"
import { collections } from "./db"

/** The agent's pages (@mb/web-kit/agent), on this bot's database. */
export const { getEpisodes, getEpisode, getShadowBook, getAgentMemory } = createAgentQueries({ collections })

export { agentStatusView } from "@mb/web-kit/agent"
