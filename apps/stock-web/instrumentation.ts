import { reportRequestErrors } from "@mb/web-kit/instrumentation"

/** Reports unhandled server errors (page renders, route handlers) to Discord. */
export const onRequestError = reportRequestErrors(() => import("@/lib/alerts"))
