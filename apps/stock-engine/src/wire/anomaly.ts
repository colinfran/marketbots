// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.

/**
 * Deterministic market-data anomalies from closed 1-minute bars (MASTER_PLAN §3.6).
 *
 * Per symbol: a ring of up to a day of bars; σ is the EWMA standard deviation of 1-minute log
 * returns (the current bar excluded); z₁ = r₁/σ, z₅ = r₅/(σ√5), z₁₅ = r₁₅/(σ√15); the volume
 * multiple is the bar's volume over the trailing median. A move the whole market shares is not
 * news about one symbol, so non-reference symbols are judged on their residual against the
 * reference (BTC for crypto, SPY for stocks) with a rolling β.
 *
 * No signals until 120 bars exist. After a signal, the symbol can't fire that kind again until
 * |z| (or the volume multiple) has fallen below half the threshold AND 15 minutes have passed.
 */

/** `volume` may be NaN when the bar's source has none: the bar still scores price, never volume. */
export type Bar = { t: number; close: number; volume: number }

export type AnomalyKind = "price" | "volume" | "market"

export type AnomalySignal = {
  symbol: string
  kind: AnomalyKind
  at: number
  /** The strongest of z₁, z₅, z₁₅ (signed), on the residual for non-reference symbols. */
  z: number
  window_min: 1 | 5 | 15
  ret_pct: number
  volume_multiple: number | null
}

export type AnomalyThresholds = { priceZ: number; volumeMultiple: number; marketZ: number }

const WARMUP = 120
const MAX_BARS = 1_440
const BETA_WINDOW = 240
const REARM_MS = 15 * 60_000
/** EWMA weight for a one-day memory of 1-minute returns. */
const ALPHA = 2 / (MAX_BARS + 1)

type Track = {
  bars: Bar[]
  /** EWMA variance of raw and residual 1-minute log returns. */
  varRaw: number | null
  varResid: number | null
  /** Recent residual 1-minute returns (for 5/15-minute residual sums). */
  resid: number[]
  rawReturns: number[]
  /** Bar time of each entry in rawReturns, and (reference only) the return at each bar time, for aligning with it. */
  returnTimes: number[]
  returnAt: Map<number, number>
  fired: Partial<Record<AnomalyKind, { at: number; armed: boolean }>>
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const sumLast = (xs: number[], n: number) => xs.slice(-n).reduce((a, b) => a + b, 0)

export class AnomalyDetector {
  private readonly tracks = new Map<string, Track>()

  constructor(
    /** The market reference (BTC/USD, SPY): judged on raw moves, and the base for residuals. */
    readonly reference: string,
    private readonly thresholds: () => AnomalyThresholds,
  ) {}

  private track(symbol: string): Track {
    let t = this.tracks.get(symbol)
    if (!t) {
      t = { bars: [], varRaw: null, varResid: null, resid: [], rawReturns: [], returnTimes: [], returnAt: new Map(), fired: {} }
      this.tracks.set(symbol, t)
    }
    return t
  }

  barCount(symbol: string) {
    return this.tracks.get(symbol)?.bars.length ?? 0
  }

  lastBar(symbol: string): Bar | null {
    return this.tracks.get(symbol)?.bars.at(-1) ?? null
  }

  /** Drops a symbol's history (it left the tracked set). */
  forget(symbol: string) {
    if (symbol !== this.reference) this.tracks.delete(symbol)
  }

  /** Loads history without emitting signals (boot backfill). Bars must be in time order. */
  backfill(symbol: string, bars: Bar[]) {
    for (const b of bars) this.add(symbol, b, false)
  }

  /** A closed bar. Feed the reference symbol's bar first each minute, so residuals use it. */
  addBar(symbol: string, bar: Bar): AnomalySignal[] {
    return this.add(symbol, bar, true)
  }

  /** β of the symbol's 1-minute returns on the reference's, over the trailing window of minutes both traded. */
  private beta(t: Track, ref: Track) {
    const a: number[] = []
    const b: number[] = []
    for (let i = t.rawReturns.length - 1; i >= 0 && a.length < BETA_WINDOW; i--) {
      const r = ref.returnAt.get(t.returnTimes[i])
      if (r === undefined) continue
      a.push(t.rawReturns[i])
      b.push(r)
    }
    const n = a.length
    if (n < 30) return 1
    const ma = a.reduce((s, x) => s + x, 0) / n
    const mb = b.reduce((s, x) => s + x, 0) / n
    let cov = 0
    let vb = 0
    for (let i = 0; i < n; i++) {
      cov += (a[i] - ma) * (b[i] - mb)
      vb += (b[i] - mb) ** 2
    }
    return vb > 0 ? cov / vb : 1
  }

  private add(symbol: string, bar: Bar, emit: boolean): AnomalySignal[] {
    const t = this.track(symbol)
    const prev = t.bars.at(-1)
    if (prev && bar.t <= prev.t) return []
    if (!(bar.close > 0)) return []
    const isRef = symbol === this.reference
    const ref = isRef ? null : this.tracks.get(this.reference)
    const r = prev ? Math.log(bar.close / prev.close) : 0
    // The reference's return for the same minute (it is fed first), else none.
    const refR = ref?.returnAt.get(bar.t) ?? 0
    const beta = ref ? this.beta(t, ref) : 1
    const residual = isRef ? r : r - beta * refR

    const signals: AnomalySignal[] = []
    const th = this.thresholds()
    const ready = t.bars.length >= WARMUP && t.varResid !== null && t.varRaw !== null
    if (ready && emit && prev) {
      const sigma = Math.sqrt(isRef ? t.varRaw! : t.varResid!)
      if (sigma > 0) {
        const series = isRef ? [...t.rawReturns, r] : [...t.resid, residual]
        const candidates: { z: number; w: 1 | 5 | 15; ret: number }[] = ([1, 5, 15] as const).map((w) => {
          const sum = sumLast(series, w)
          return { z: sum / (sigma * Math.sqrt(w)), w, ret: (Math.exp(sumLast([...t.rawReturns, r], w)) - 1) * 100 }
        })
        const best = candidates.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a))
        const kind: AnomalyKind = isRef ? "market" : "price"
        // The market shock is judged on the 5-minute move, idiosyncratic shocks on any window.
        const zFor = isRef ? candidates[1] : best
        const threshold = isRef ? th.marketZ : th.priceZ
        if (this.gate(t, kind, Math.abs(zFor.z), threshold, bar.t)) {
          signals.push({ symbol, kind, at: bar.t, z: round2(zFor.z), window_min: zFor.w, ret_pct: round2(zFor.ret), volume_multiple: null })
        }
      }
      const med = median(t.bars.slice(-MAX_BARS).flatMap((b) => (Number.isFinite(b.volume) ? [b.volume] : [])))
      const multiple = med > 0 && Number.isFinite(bar.volume) ? bar.volume / med : null
      if (multiple !== null && this.gate(t, "volume", multiple, th.volumeMultiple, bar.t)) {
        signals.push({ symbol, kind: "volume", at: bar.t, z: 0, window_min: 1, ret_pct: round2((Math.exp(r) - 1) * 100), volume_multiple: round2(multiple) })
      }
    }

    // Update state with the closed bar (after scoring, so σ excludes it).
    if (prev) {
      t.varRaw = t.varRaw === null ? r * r : (1 - ALPHA) * t.varRaw + ALPHA * r * r
      t.varResid = t.varResid === null ? residual * residual : (1 - ALPHA) * t.varResid + ALPHA * residual * residual
      t.rawReturns.push(r)
      t.returnTimes.push(bar.t)
      // Only the reference's returns are looked up by time; other symbols skip the map (it's most of a track's memory).
      if (isRef) t.returnAt.set(bar.t, r)
      t.resid.push(residual)
      if (t.rawReturns.length > MAX_BARS) {
        t.rawReturns.shift()
        const dropped = t.returnTimes.shift()!
        if (isRef) t.returnAt.delete(dropped)
      }
      if (t.resid.length > MAX_BARS) t.resid.shift()
    }
    t.bars.push(bar)
    if (t.bars.length > MAX_BARS) t.bars.shift()
    return signals
  }

  /** Fires once per excursion: re-arms only after the value falls below half the threshold and 15 minutes pass. */
  private gate(t: Track, kind: AnomalyKind, value: number, threshold: number, at: number) {
    const state = t.fired[kind]
    if (state && !state.armed && value < threshold / 2 && at - state.at >= REARM_MS) state.armed = true
    if (value < threshold) return false
    if (state && !state.armed) return false
    t.fired[kind] = { at, armed: false }
    return true
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
