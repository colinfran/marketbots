import { signStreamToken } from "@mb/crypto-core/stream-token"
import { streamTokenRoute } from "@mb/web-kit/commands"
import { getViewer } from "@/lib/auth"
import { env } from "@/lib/env"

/** A 60-second token for the engine's WebSocket stream: owner scope with a valid owner session, public otherwise. */
export const GET = streamTokenRoute({ getViewer, env, sign: signStreamToken })
