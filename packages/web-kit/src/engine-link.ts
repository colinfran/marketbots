import "server-only"
import type { SignedRequest } from "@mb/core/stream-token"

/**
 * The dashboard's server calling its engine directly: the engine's HTTP endpoints at `url`
 * (ENGINE_URL: on the server, the engine's loopback port through http://host.docker.internal), or
 * without it at the origin of its stream URL (wss://engine.example.app/v1/stream →
 * https://engine.example.app). Each request is signed with the stream secret and the bot core's
 * request prefix (@mb/core/stream-token). The browser never calls them.
 */

/** The engine's endpoints: where they are (`url`, else the stream URL's origin), the shared secret, and the bot core's request signer. */
export type EngineLink = {
  streamUrl: () => string | null
  url?: () => string | null
  secret: () => string | null
  sign: (secret: string, request: SignedRequest) => Record<string, string>
}

/** Why a call got no answer: the link isn't set up here, the engine didn't answer in time, or it couldn't be reached at all. */
export type EngineMiss = "unconfigured" | "timeout" | "unreachable"

/** The http(s) origin of an engine URL: its own address (http://…) or its stream URL (wss://… → https://…). */
const engineOrigin = (value: string | null | undefined) => {
  if (!value) return null
  try {
    const url = new URL(value)
    return `${url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/** A signed call to the engine: its response, or why there is none. */
export const callEngine = async (
  engine: EngineLink,
  { method, path, body = "", timeoutMs, fetchFn = fetch }: { method: "GET" | "POST"; path: string; body?: string; timeoutMs: number; fetchFn?: typeof fetch },
): Promise<Response | EngineMiss> => {
  const origin = engineOrigin(engine.url?.()) ?? engineOrigin(engine.streamUrl())
  const secret = engine.secret()
  if (!origin || !secret) return "unconfigured"
  return fetchFn(`${origin}${path}`, {
    method,
    body: method === "POST" ? body : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", ...engine.sign(secret, { method, path, body }) },
  }).catch((e: unknown): EngineMiss => ((e as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "unreachable"))
}
