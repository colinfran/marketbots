import { bansRoute } from "@mb/web-kit/bans"
import { getViewer, sameOrigin } from "@/lib/auth"
import { unban } from "@/lib/bans"

/** Owner-only: lift a rate-limit ban (Admin → System's banned addresses). */
export const DELETE = bansRoute({ getViewer, sameOrigin, unban })
