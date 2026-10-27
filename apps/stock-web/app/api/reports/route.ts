import { PHASES, type Phase } from "@mb/stock-core/settings"
import { NextResponse } from "next/server"
import { listReports } from "@/lib/queries"

/** GET /api/reports?limit=50&phase=intraday: report summaries, newest first. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Math.floor(Number(params.get("limit")) || 50), 1), 500)
  const phase = params.get("phase") as Phase | null
  return NextResponse.json(await listReports(limit, phase && PHASES.includes(phase) ? phase : undefined))
}
