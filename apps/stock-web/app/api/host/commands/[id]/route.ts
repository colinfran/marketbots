import { commandRoute } from "@mb/web-kit/commands"
import { getViewer } from "@/lib/auth"
import { collections } from "@/lib/db"

/** Owner-only: a host command's status, polled by the UI until the host agent has answered it. */
export const GET = commandRoute({ getViewer, commands: async () => (await collections()).hostCommands })
