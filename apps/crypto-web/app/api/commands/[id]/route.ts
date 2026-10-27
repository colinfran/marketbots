import { commandRoute } from "@mb/web-kit/commands"
import { getViewer } from "@/lib/auth"
import { collections } from "@/lib/db"

/** Owner-only: a queued command's status, polled by the UI until the engine has processed it. */
export const GET = commandRoute({ getViewer, commands: async () => (await collections()).commands })
