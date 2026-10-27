import { NextResponse } from "next/server"
import { getEngine, getLatestReport, getLiveAccount } from "@/lib/queries"

/** GET /api/status: account, positions (stocks and options), engine state and the latest report headline. */
export async function GET() {
  const [account, engine, latest] = await Promise.all([getLiveAccount(), getEngine(), getLatestReport()])
  const s = engine.status
  return NextResponse.json({
    account,
    engine: s
      ? { online: engine.online, status: s.status, cycle_state: s.cycle_state, kill_switch: s.kill_switch, schedule: s.schedule, market: s.market, last_cycle: s.last_cycle }
      : { online: false },
    latest_report: latest ? { id: latest._id, phase: latest.phase, created_at: latest.created_at, headline: latest.report.headline } : null,
  })
}
