import "server-only"
import { createHost } from "@mb/web-kit/host"
import { collections } from "./db"

/** Admin → Server (@mb/web-kit/host): the host agent's readings and commands, in this bot's database. */
export const { getHostStatus, getHostHistory, submitHostCommand } = createHost({ collections })
