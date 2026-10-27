import { NextResponse } from "next/server"
import { getViewer } from "@/lib/auth"
import { collections } from "@/lib/db"

/** Owner-only: a queued command's status, polled by the UI until the engine has processed it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
  const { id } = await params
  const { commands } = await collections()
  const doc = await commands.findOne({ _id: id }, { projection: { status: 1, result: 1, error: 1, type: 1 } })
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json(doc, { headers: { "cache-control": "no-store" } })
}
