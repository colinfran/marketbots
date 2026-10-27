import { vi } from "vitest"

/**
 * Fakes Date and setTimeout so code that sleeps (retry backoff, order polling) runs instantly.
 * MongoDB keeps working because the driver schedules its own timers through node:timers.
 */
export const useFakeClock = (now: Date | string) =>
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date(now) })

/**
 * Awaits a promise under fake timers: fires the next timer whenever the code is sleeping, and
 * otherwise yields to the event loop so real I/O (MongoDB) can complete.
 */
export const settle = async <T>(promise: Promise<T>): Promise<T> => {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true),
  )
  while (!done) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await new Promise((resolve) => setImmediate(resolve))
  }
  return promise
}
