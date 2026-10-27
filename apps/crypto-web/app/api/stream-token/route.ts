import { signStreamToken } from "@mb/crypto-core/stream-token"
import { NextResponse } from "next/server"
import { getViewer } from "@/lib/auth"
import { env } from "@/lib/env"

/**
 * Mints a 60-second token for the engine's WebSocket stream: owner scope with a valid owner
 * session, public scope otherwise. The browser sends it as its first frame after connecting.
 */
export async function GET() {
  const url = env.engineStreamUrl()
  const secret = env.streamTokenSecret()
  if (!url || !secret) return NextResponse.json({ url: null, token: null, scope: null }, { headers: { "cache-control": "no-store" } })
  const viewer = await getViewer()
  const scope = viewer.owner ? "owner" : "public"
  const { token, payload } = signStreamToken(scope, secret)
  return NextResponse.json({ url, token, scope, expires_at: payload.exp * 1000 }, { headers: { "cache-control": "no-store" } })
}
