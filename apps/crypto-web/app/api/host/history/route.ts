import { hostHistoryRoute } from "@mb/web-kit/host"
import { getViewer } from "@/lib/auth"
import { getHostHistory } from "@/lib/host"

/** Owner-only: chart points for one range of Admin → Server's history. */
export const GET = hostHistoryRoute({ getViewer, getHostHistory })
