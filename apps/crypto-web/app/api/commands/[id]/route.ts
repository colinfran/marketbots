import { commandRoute } from "@mb/web-kit/commands"
import { getViewer } from "@/lib/auth"
import { getEngineCommand } from "@/lib/commands"
import { collections } from "@/lib/db"

/** Owner-only: a command's status, from the engine (or the record it saved), polled by the UI until the engine has answered it. */
export const GET = commandRoute({ getViewer, commands: async () => (await collections()).commands, engineCommand: getEngineCommand })
