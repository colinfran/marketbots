import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { EventVisibility } from "./events"

/**
 * Short-lived tokens for an engine's WebSocket stream. The Vercel app mints one per connection
 * attempt (public scope for anyone, owner scope only with a valid owner session); the engine
 * verifies it with the same shared secret. Tokens are only checked when a socket connects, so a
 * 60-second lifetime is plenty and a leaked token is useless almost immediately.
 *
 * Format: "v1.<base64url(payload json)>.<base64url(hmac-sha256)>". The HMAC covers a per-bot
 * context prefix and the payload, so a token minted for one bot never verifies on the other, even
 * with the same secret.
 */

export type StreamTokenPayload = { v: 1; scope: EventVisibility; iat: number; exp: number; jti: string }

export const STREAM_TOKEN_TTL_SECONDS = 60

export type TokenCheck = { ok: true; payload: StreamTokenPayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" }

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url")

const assertSecret = (secret: string) => {
  if (!secret || secret.length < 32) throw new Error("STREAM_TOKEN_SECRET must be at least 32 characters")
}

/** Sign and verify, bound to one bot's HMAC context prefix (e.g. "cmb-stream."). */
export const streamTokens = (context: string) => {
  const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`${context}${body}`).digest()

  const sign = (
    scope: EventVisibility,
    secret: string,
    { now = Date.now(), ttlSeconds = STREAM_TOKEN_TTL_SECONDS }: { now?: number; ttlSeconds?: number } = {},
  ): { token: string; payload: StreamTokenPayload } => {
    assertSecret(secret)
    const iat = Math.floor(now / 1000)
    const payload: StreamTokenPayload = { v: 1, scope, iat, exp: iat + ttlSeconds, jti: randomUUID() }
    const body = b64url(JSON.stringify(payload))
    return { token: `v1.${body}.${b64url(mac(body, secret))}`, payload }
  }

  const verify = (token: string, secret: string, now = Date.now()): TokenCheck => {
    assertSecret(secret)
    const parts = token.split(".")
    if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" }
    const [, body, signature] = parts
    const expected = mac(body, secret)
    const given = Buffer.from(signature, "base64url")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" }
    let payload: StreamTokenPayload
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    } catch {
      return { ok: false, reason: "malformed" }
    }
    if (payload?.v !== 1 || (payload.scope !== "public" && payload.scope !== "owner") || typeof payload.exp !== "number") {
      return { ok: false, reason: "malformed" }
    }
    if (payload.exp * 1000 < now) return { ok: false, reason: "expired" }
    return { ok: true, payload }
  }

  return { sign, verify }
}

/**
 * Requests from a dashboard's server to its engine (the owner's commands), signed with the same
 * shared secret: an HMAC over a per-bot context prefix, the method, the path, a millisecond
 * timestamp and the body, sent in REQUEST_HEADERS. The engine refuses a signature that doesn't
 * match or a timestamp more than REQUEST_MAX_SKEW_MS away from its clock. The secret never travels.
 */

export const REQUEST_HEADERS = { timestamp: "x-mb-timestamp", signature: "x-mb-signature" } as const

export const REQUEST_MAX_SKEW_MS = 60_000

export type SignedRequest = { method: string; path: string; body: string }

/** Sign and verify requests, bound to one bot's HMAC context prefix (e.g. "cmb-request."). */
export const requestSignatures = (context: string) => {
  const mac = (secret: string, { method, path, body }: SignedRequest, timestamp: string) =>
    createHmac("sha256", secret).update(`${context}${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`).digest()

  /** The headers to send with the request. */
  const sign = (secret: string, request: SignedRequest, now = Date.now()): Record<string, string> => {
    assertSecret(secret)
    const timestamp = String(now)
    return { [REQUEST_HEADERS.timestamp]: timestamp, [REQUEST_HEADERS.signature]: mac(secret, request, timestamp).toString("hex") }
  }

  const verify = (secret: string, request: SignedRequest, headers: { timestamp: string | undefined; signature: string | undefined }, now = Date.now()): boolean => {
    assertSecret(secret)
    const at = Number(headers.timestamp)
    if (!headers.timestamp || !headers.signature || !Number.isFinite(at) || Math.abs(now - at) > REQUEST_MAX_SKEW_MS) return false
    const expected = mac(secret, request, headers.timestamp)
    const given = Buffer.from(headers.signature, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  return { sign, verify }
}
