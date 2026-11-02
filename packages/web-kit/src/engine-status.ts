import "server-only"
import { BSON } from "mongodb"
import { connection } from "next/server"
import { cache } from "react"
import { callEngine, type EngineLink } from "./engine-link"

/**
 * The engine's heartbeat, as the dashboard's server reads it: straight from the engine's signed
 * GET /v1/status (@mb/engine-kit/stream), never from the database. Sent as relaxed Extended JSON,
 * so its dates come back as dates. Read once per request (React `cache`): the layout and the page
 * share one call.
 */

/** The engine counts as online if its last beat is fresher than this. */
const HEARTBEAT_STALE_MS = 30_000

/** How long a page waits for the engine's status before showing it offline. */
const STATUS_TIMEOUT_MS = 3_000

export type EngineSummary<S> = { status: S | null; online: boolean; heartbeatAgeS: number | null }

const OFFLINE = { status: null, online: false, heartbeatAgeS: null }

/** Binds the status read to a bot's engine and its status document type. */
export const createEngineStatus = <S extends { at: Date }>(engine: EngineLink, fetchFn: typeof fetch = fetch) =>
  cache(async (): Promise<EngineSummary<S>> => {
    await connection()
    const res = await callEngine(engine, { method: "GET", path: "/v1/status", timeoutMs: STATUS_TIMEOUT_MS, fetchFn })
    if (typeof res === "string" || !res.ok) return OFFLINE
    const status = BSON.EJSON.parse(await res.text(), { relaxed: true }) as S
    const age = (Date.now() - status.at.getTime()) / 1000
    return { status, online: age * 1000 < HEARTBEAT_STALE_MS, heartbeatAgeS: Math.round(age) }
  })
