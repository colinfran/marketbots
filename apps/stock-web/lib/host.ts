import "server-only"
import { createHost } from "@mb/web-kit/host"
import { collections } from "./db"
import { env } from "./env"

/** Admin → Server (@mb/web-kit/host): the host agent's readings and commands, from its API; requests audited in this bot's log. */
export const { getHostStatus, getHostHistory, submitHostCommand, getHostCommand } = createHost({ env, audit: async () => (await collections()).audit })
