import { hostStatusRoute } from "@mb/web-kit/host"
import { getViewer } from "@/lib/auth"
import { getHostStatus } from "@/lib/host"

/** Owner-only: the host agent's latest reading, polled by Admin → Server. */
export const GET = hostStatusRoute({ getViewer, getHostStatus })
