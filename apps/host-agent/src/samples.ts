import { HOST_MINUTE_KEEP_MS, HOST_RAW_KEEP_MS, sampleId, type HostSampleDoc, type HostSampleGpu } from "@mb/core/host"
import { MINUTE_MS, splitByMinute, type PowerReading } from "./energy"

/** What one reading contributes to the charts. */
export type SampleInput = { t: number; cpu: number | null; cpu_temp: number | null; memory: number | null; watts: number | null; outlet_id: string | null; gpus: HostSampleGpu[] }

/** One reading as a raw sample (the hour views). */
export const rawSample = (s: SampleInput): HostSampleDoc => ({
  _id: sampleId("raw", s.t),
  res: "raw",
  t: new Date(s.t),
  cpu: s.cpu,
  cpu_temp: s.cpu_temp,
  memory: s.memory,
  watts: s.watts,
  gpus: s.gpus,
  wh: null,
  covered_ms: 0,
  outlet_id: s.outlet_id,
  expires_at: new Date(s.t + HOST_RAW_KEEP_MS),
})

type Mean = { sum: number; n: number }

const mean = () => ({ sum: 0, n: 0 })
const push = (m: Mean, v: number | null) => {
  if (v !== null && Number.isFinite(v)) {
    m.sum += v
    m.n++
  }
}
const avg = (m: Mean) => (m.n ? m.sum / m.n : null)

type Minute = {
  t: number
  cpu: Mean
  cpu_temp: Mean
  memory: Mean
  watts: Mean
  gpus: Map<string, { model: string; util: Mean; temp: Mean }>
  wh: number
  covered_ms: number
  outlet_id: string | null
}

const empty = (t: number): Minute => ({ t, cpu: mean(), cpu_temp: mean(), memory: mean(), watts: mean(), gpus: new Map(), wh: 0, covered_ms: 0, outlet_id: null })

/**
 * Minute samples (the 24-hour to 30-day views): each minute's averages, and the energy measured in
 * it (an interval straddling a minute boundary is split between the two). A minute is handed back
 * once a reading from a later minute arrives, or by `flush()`. `gap`: the reading is the first
 * after a restart, so no energy is counted from the one before.
 */
export class MinuteSamples {
  private readonly open = new Map<number, Minute>()
  private last: PowerReading | null = null

  add(s: SampleInput, { gap = false }: { gap?: boolean } = {}): HostSampleDoc[] {
    const reading: PowerReading = { t: s.t, watts: s.watts, outlet: s.outlet_id }
    if (this.last && !gap) {
      for (const part of splitByMinute(this.last, reading)) {
        const m = this.minute(part.minute)
        m.wh += part.wh
        m.covered_ms += part.covered_ms
        m.outlet_id = reading.outlet
      }
    }
    this.last = reading
    const m = this.minute(Math.floor(s.t / MINUTE_MS) * MINUTE_MS)
    push(m.cpu, s.cpu)
    push(m.cpu_temp, s.cpu_temp)
    push(m.memory, s.memory)
    push(m.watts, s.watts)
    if (s.outlet_id) m.outlet_id = s.outlet_id
    for (const g of s.gpus) {
      const slot = m.gpus.get(g.id) ?? { model: g.model, util: mean(), temp: mean() }
      push(slot.util, g.util)
      push(slot.temp, g.temp)
      m.gpus.set(g.id, slot)
    }
    return this.done(m.t)
  }

  /** Every minute still open (on shutdown, and at the end of an import). */
  flush(): HostSampleDoc[] {
    return this.done(Infinity)
  }

  private minute(t: number) {
    let m = this.open.get(t)
    if (!m) this.open.set(t, (m = empty(t)))
    return m
  }

  /** Hands back the minutes before `before`, oldest first. */
  private done(before: number): HostSampleDoc[] {
    const out: HostSampleDoc[] = []
    for (const t of [...this.open.keys()].sort((a, b) => a - b)) {
      if (t >= before) break
      const m = this.open.get(t)!
      this.open.delete(t)
      out.push({
        _id: sampleId("1m", t),
        res: "1m",
        t: new Date(t),
        cpu: avg(m.cpu),
        cpu_temp: avg(m.cpu_temp),
        memory: avg(m.memory),
        watts: avg(m.watts),
        gpus: [...m.gpus].map(([id, g]) => ({ id, model: g.model, util: avg(g.util), temp: avg(g.temp) })),
        wh: m.covered_ms ? m.wh : null,
        covered_ms: m.covered_ms,
        outlet_id: m.outlet_id,
        expires_at: new Date(t + HOST_MINUTE_KEEP_MS),
      })
    }
    return out
  }
}
