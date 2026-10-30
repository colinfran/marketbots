import { NextResponse } from "next/server"
import { getEngine, getLiveAccount } from "@/lib/queries"

/** GET /api/status: account, positions (stocks and options), the engine's state and the agent's. */
export async function GET() {
  const [account, engine] = await Promise.all([getLiveAccount(), getEngine()])
  const s = engine.status
  const agent = s?.agent
  return NextResponse.json({
    account,
    engine: s ? { online: engine.online, status: s.status, kill_switch: s.kill_switch, market: s.market } : { online: false },
    agent: agent
      ? { level: agent.level, state: agent.state, model: agent.model, episodes_today: agent.episodes_today, last_episode_at: agent.last_episode_at, entries_paused: agent.entries_paused }
      : null,
  })
}
