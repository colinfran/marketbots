/** Async helpers: sleeping, backoff, and running periodic jobs without overlap. */

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

/** Exponential backoff with full jitter: attempt 1 → up to base, doubling to max. */
export const backoffMs = (attempt: number, baseMs = 500, maxMs = 30_000) =>
  Math.round(Math.random() * Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1)))

/**
 * Runs `fn` every `intervalMs`. A slow run never overlaps the next one; errors are reported and the
 * loop keeps going. Returns a stop function.
 */
export const every = (intervalMs: number, fn: () => Promise<void> | void, onError: (error: unknown) => void, { immediate = false } = {}) => {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const tick = async () => {
    if (stopped) return
    try {
      await fn()
    } catch (error) {
      onError(error)
    }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }
  timer = setTimeout(tick, immediate ? 0 : intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** Resolves with fn's result or rejects after `ms`. The underlying work isn't cancelled. */
export const withTimeout = <T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })

/** A token bucket for client-side rate limiting (Kraken limits public calls per IP; Alpaca allows ~200 requests per minute per account). */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.last = now()
  }

  private refill() {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond)
    this.last = t
  }

  /** Waits until `cost` tokens are available, then takes them. */
  async take(cost = 1): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= cost) {
        this.tokens -= cost
        return
      }
      const waitMs = ((cost - this.tokens) / this.refillPerSecond) * 1000
      await sleep(Math.max(10, Math.ceil(waitMs)))
    }
  }
}
