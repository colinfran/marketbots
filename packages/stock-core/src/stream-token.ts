import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { EventVisibility } from "./events"

/**
 * Short-lived tokens for the engine's WebSocket stream. The Vercel app mints one per connection
 * attempt (public scope for anyone, owner scope only with a valid owner session); the engine
 * verifies it with the same shared secret. Tokens are only checked when a socket connects, so a
 * 60-second lifetime is plenty and a leaked token is useless almost immediately.
 *
 * Format: "v1.<base64url(payload json)>.<base64url(hmac-sha256)>".
 */

export type StreamTokenPayload = { v: 1; scope: EventVisibility; iat: number; exp: number; jti: string }

export const STREAM_TOKEN_TTL_SECONDS = 60

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url")

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`smb-stream.${body}`).digest()

const assertSecret = (secret: string) => {
  if (!secret || secret.length < 32) throw new Error("STREAM_TOKEN_SECRET must be at least 32 characters")
}

export const signStreamToken = (
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

export type TokenCheck = { ok: true; payload: StreamTokenPayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" }

export const verifyStreamToken = (token: string, secret: string, now = Date.now()): TokenCheck => {
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
