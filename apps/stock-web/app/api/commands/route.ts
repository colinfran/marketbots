import { commandsRoute } from "@mb/web-kit/commands"
import { getViewer, sameOrigin } from "@/lib/auth"
import { submitCommand } from "@/lib/commands"

/** Owner-only: queue a command for the engine (pause, kill switch, settings, …). */
export const POST = commandsRoute({ getViewer, sameOrigin, submitCommand })
