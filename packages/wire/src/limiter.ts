import { TokenBucket } from "@mb/engine-kit/util/async"

/**
 * Per-domain rate limits for everything the news engine fetches, so a free source never sees a
 * burst from us. Rates are keyed by domain suffix (the longest match wins); unknown domains get
 * the polite default of one request every two seconds.
 *
 * Both bots run on one server and share its IP: SEC's fair-access limit (10 requests/s) is split
 * between them, so each stays at 4/s. GDELT asks for at most one request every 5 seconds, and
 * StockTwits allows about 200 unauthenticated requests an hour per IP (shared by both bots). Bithumb
 * allows one request a second per IP.
 */

export type DomainRate = { capacity: number; perSecond: number }

const DEFAULT_RATE: DomainRate = { capacity: 2, perSecond: 0.5 }

export const DOMAIN_RATES: Record<string, DomainRate> = {
  "sec.gov": { capacity: 4, perSecond: 4 },
  "news.google.com": { capacity: 2, perSecond: 0.25 },
  "finnhub.io": { capacity: 5, perSecond: 0.8 },
  "t.me": { capacity: 3, perSecond: 0.5 },
  "kraken.com": { capacity: 3, perSecond: 1 },
  "coinbase.com": { capacity: 3, perSecond: 1 },
  "gdeltproject.org": { capacity: 1, perSecond: 0.2 },
  "stocktwits.com": { capacity: 2, perSecond: 0.05 },
  "bithumb.com": { capacity: 1, perSecond: 0.5 },
  "deribit.com": { capacity: 4, perSecond: 2 },
  "wikimedia.org": { capacity: 5, perSecond: 2 },
}

export const rateFor = (host: string, rates: Record<string, DomainRate> = DOMAIN_RATES): { key: string; rate: DomainRate } => {
  const h = host.toLowerCase().replace(/^www\./, "")
  const match = Object.keys(rates)
    .filter((k) => h === k || h.endsWith(`.${k}`))
    .sort((a, b) => b.length - a.length)[0]
  return match ? { key: match, rate: rates[match] } : { key: h, rate: DEFAULT_RATE }
}

export class DomainLimiter {
  private readonly buckets = new Map<string, TokenBucket>()

  constructor(
    private readonly rates: Record<string, DomainRate> = DOMAIN_RATES,
    private readonly now: () => number = Date.now,
  ) {}

  /** Waits for this URL's domain to have capacity. */
  async take(url: string) {
    const { key, rate } = rateFor(new URL(url).hostname, this.rates)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = new TokenBucket(rate.capacity, rate.perSecond, this.now)
      this.buckets.set(key, bucket)
    }
    await bucket.take()
  }
}
