import type { Instrumentation } from "next"

/**
 * instrumentation.ts: reports unhandled server errors (page renders, route handlers) to Discord.
 * `load` imports the app's alerts module lazily, so the edge runtime never loads server-only code.
 */

type Alerts = {
  errorMessage: (error: unknown) => string
  sendAlert: (alert: { title: string; message: string; fields?: Record<string, string | undefined>; path?: string; key?: string }) => Promise<void>
}

export const reportRequestErrors =
  (load: () => Promise<Alerts>): Instrumentation.onRequestError =>
  async (error, request, context) => {
    if (process.env.NEXT_RUNTIME !== "nodejs") return
    const { errorMessage, sendAlert } = await load()
    const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined
    await sendAlert({
      title: `Server error on ${context.routePath}`,
      message: errorMessage(error),
      fields: { Path: request.path, Method: request.method, Type: context.routeType, Digest: digest },
      path: request.method === "GET" && !request.path.startsWith("/api/") ? request.path : undefined,
      key: `request|${context.routePath}|${errorMessage(error)}`,
    })
  }
