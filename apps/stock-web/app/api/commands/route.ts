import { NextResponse } from "next/server"
import { getViewer, sameOrigin } from "@/lib/auth"
import { submitCommand } from "@/lib/commands"

/** Owner-only: queue a command for the engine (pause, kill switch, settings, …). */
export async function POST(request: Request) {
  if (!(await sameOrigin())) return NextResponse.json({ error: "bad origin" }, { status: 403 })
  if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
  const body = await request.json().catch(() => null)
  const result = await submitCommand(body, "owner")
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ id: result.id }, { status: 202 })
}
