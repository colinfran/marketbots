import type { Instrumentation } from "next"

/** Reports unhandled server errors (page renders, route handlers) to Discord. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { errorMessage, sendAlert } = await import("@/lib/alerts")
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined
  await sendAlert({
    title: `Server error on ${context.routePath}`,
    message: errorMessage(error),
    fields: { Path: request.path, Method: request.method, Type: context.routeType, Digest: digest },
    path: request.method === "GET" && !request.path.startsWith("/api/") ? request.path : undefined,
    key: `request|${context.routePath}|${errorMessage(error)}`,
  })
}
