import { NextResponse } from "next/server"
import { listTrades } from "@/lib/queries"

/** GET /api/trades?limit=100: fills (stocks and option legs) with FIFO realized P&L and the decision rationale, newest first. */
export async function GET(request: Request) {
  const limit = Math.min(Math.max(Math.floor(Number(new URL(request.url).searchParams.get("limit")) || 100), 1), 1000)
  return NextResponse.json(await listTrades(limit))
}
