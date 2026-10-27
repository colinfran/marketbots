import { NextResponse } from "next/server"
import { listDays } from "@/lib/queries"

/** GET /api/days: daily performance records, newest first. */
export async function GET() {
  return NextResponse.json(await listDays())
}
