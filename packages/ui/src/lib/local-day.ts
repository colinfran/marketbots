/**
 * The viewer's own day, in the time zone of the browser that runs it (on a server, the process's).
 * The dashboards render on the server, which can't know the viewer's zone, so counts "today" in the
 * viewer's day are made in the browser from timestamps the page reads.
 */

/** Local midnight at the start of the day `now` (ms) falls on. A day is 23 to 25 hours long around a clock change. */
export const localDayStart = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How many of `times` (ms) fall on or after the start of `now`'s local day. */
export const countLocalDay = (times: readonly number[], now: number) => {
  const start = localDayStart(now)
  let n = 0
  for (const t of times) if (t >= start) n += 1
  return n
}
