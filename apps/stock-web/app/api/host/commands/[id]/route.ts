import { hostCommandRoute } from "@mb/web-kit/host"
import { getViewer } from "@/lib/auth"
import { getHostCommand } from "@/lib/host"

/** Owner-only: a host command's status, polled by the UI until the host agent has answered it. */
export const GET = hostCommandRoute({ getViewer, getHostCommand })
