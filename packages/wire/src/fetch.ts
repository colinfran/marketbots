import type { httpClient } from "@mb/engine-kit/util/http"
import type { DomainLimiter } from "./limiter"

/**
 * HTTP for the news engine: per-domain rate limited, conditional (ETag / If-Modified-Since, so an
 * unchanged feed costs the source almost nothing), one attempt per call (the source's poll loop
 * owns retries and backoff), and a descriptive User-Agent with a contact address.
 *
 * The requests go through the engine's own HTTP client (its `requestText`, @mb/engine-kit/util/http).
 */

/** The engine's request function. */
export type RequestText = ReturnType<typeof httpClient>["requestText"]

export type FetchResult = { status: number; text: string; notModified: boolean }

export type FetchOptions = { headers?: Record<string, string>; conditional?: boolean; timeoutMs?: number }

export class WireFetch {
  private readonly validators = new Map<string, { etag: string | null; lastModified: string | null }>()

  constructor(
    private readonly limiter: Pick<DomainLimiter, "take">,
    private readonly userAgent: string,
    private readonly request: RequestText,
  ) {}

  async get(url: string, { headers = {}, conditional = true, timeoutMs = 15_000 }: FetchOptions = {}): Promise<FetchResult> {
    await this.limiter.take(url)
    const v = conditional ? this.validators.get(url) : undefined
    const res = await this.request(url, {
      headers: {
        "user-agent": this.userAgent,
        accept: "*/*",
        ...(v?.etag ? { "if-none-match": v.etag } : {}),
        ...(v?.lastModified ? { "if-modified-since": v.lastModified } : {}),
        ...headers,
      },
      timeoutMs,
      attempts: 1,
      okStatuses: [304],
    })
    if (res.status === 304) return { status: 304, text: "", notModified: true }
    if (conditional) {
      const etag = res.headers.get("etag")
      const lastModified = res.headers.get("last-modified")
      if (etag || lastModified) this.validators.set(url, { etag, lastModified })
    }
    return { status: res.status, text: res.text, notModified: false }
  }

  /** GET and parse JSON; null when the resource hasn't changed. */
  async json<T>(url: string, opts: FetchOptions = {}): Promise<T | null> {
    const res = await this.get(url, opts)
    return res.notModified ? null : (JSON.parse(res.text) as T)
  }

  /** POST a JSON query and parse the JSON answer, for read-only APIs that take their query as a body (Hyperliquid info, BLS). Never conditional, never retried here. */
  async postJson<T>(url: string, payload: unknown, { headers = {}, timeoutMs = 15_000 }: Omit<FetchOptions, "conditional"> = {}): Promise<T> {
    await this.limiter.take(url)
    const res = await this.request(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "user-agent": this.userAgent, accept: "application/json", "content-type": "application/json", ...headers },
      timeoutMs,
      attempts: 1,
    })
    return JSON.parse(res.text) as T
  }
}
