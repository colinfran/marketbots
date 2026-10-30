import { hostCommandsRoute } from "@mb/web-kit/host"
import { getViewer, sameOrigin } from "@/lib/auth"
import { submitHostCommand } from "@/lib/host"

/** Owner-only: queue a fan, settings or outlet command for the host agent. */
export const POST = hostCommandsRoute({ getViewer, sameOrigin, submitHostCommand })
