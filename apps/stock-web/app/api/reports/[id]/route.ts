import { NextResponse } from "next/server"
import { getReport } from "@/lib/queries"

/** GET /api/reports/:id: the full report (research, structured output, market context), its decisions and cycle log. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const data = await getReport((await params).id)
  return data ? NextResponse.json(data) : NextResponse.json({ error: "Not found" }, { status: 404 })
}
