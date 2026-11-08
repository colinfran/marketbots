import { reportRequestErrors } from "@mb/web-kit/instrumentation"

/** At server start: the database storage budget's hourly check (lib/storage-watch.ts). Server-only code loads only in Node. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { startStorageWatch } = await import("@/lib/storage-watch")
  startStorageWatch()
}

/** Reports unhandled server errors (page renders, route handlers) to Discord. */
export const onRequestError = reportRequestErrors(() => import("@/lib/alerts"))
