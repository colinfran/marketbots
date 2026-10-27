import { backoffMs, sleep } from "./async"

/**
 * fetch with a timeout and retries for transient failures (network errors, 408/429/5xx), honoring
 * Retry-After. Requests that create something (orders) must pass `retry: false`: retrying a POST
 * whose first attempt may have succeeded is how duplicate orders happen. Those callers reconcile
 * instead.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/** The request may or may not have reached the server (timeout / connection reset after sending). */
export class UncertainRequestError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "UncertainRequestError"
  }
}

export type RequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Max attempts, including the first. Default 3 for GET, 1 otherwise. */
  attempts?: number
  retry?: boolean
  /** Non-2xx statuses that are answers, not failures, e.g. 304 for a conditional GET. */
  okStatuses?: number[]
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * The request functions, bound to the engine's default User-Agent: it is sent unless the caller
 * sets its own (some public APIs, the SEC's among them, require a descriptive one).
 */
export const httpClient = (defaultUserAgent: string) => {
  const withUserAgent = (headers: Record<string, string> = {}) =>
    Object.keys(headers).some((k) => k.toLowerCase() === "user-agent") ? headers : { ...headers, "user-agent": defaultUserAgent }

  const requestText = async (url: string, opts: RequestOptions = {}): Promise<{ status: number; text: string; headers: Headers }> => {
    const method = opts.method ?? "GET"
    const canRetry = opts.retry ?? method === "GET"
    const attempts = canRetry ? (opts.attempts ?? 3) : 1
    let lastError: unknown = null

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: withUserAgent(opts.headers),
          body: opts.body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        })
      } catch (error) {
        lastError = error
        if (attempt < attempts) {
          await sleep(backoffMs(attempt))
          continue
        }
        // For a non-idempotent request we can't know whether the server acted on it.
        if (method !== "GET") throw new UncertainRequestError(`${method} ${new URL(url).pathname} outcome unknown: ${(error as Error).message}`, error)
        throw error
      }
      const text = await res.text()
      if (res.ok || opts.okStatuses?.includes(res.status)) return { status: res.status, text, headers: res.headers }
      if (canRetry && RETRYABLE.has(res.status) && attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after"))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoffMs(attempt, 1_000))
        continue
      }
      throw new HttpError(res.status, `${method} ${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`, text)
    }
    throw lastError instanceof Error ? lastError : new Error(`request failed: ${String(lastError)}`)
  }

  const requestJson = async <T>(url: string, opts: RequestOptions = {}): Promise<T> => {
    const { text } = await requestText(url, opts)
    return (text ? JSON.parse(text) : undefined) as T
  }

  return { requestText, requestJson }
}
