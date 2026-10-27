import { describe, expect, it } from "vitest"
import { Lease } from "../src/lease"
import { silentLogger } from "../src/log"
import { useTestDb } from "./helpers/bot"

const db = useTestDb()

describe("Lease", () => {
  it("lets only one engine hold it, and hands it over once released", async () => {
    const first = new Lease(db.col, "engine-a:1", silentLogger)
    await first.acquire()
    expect(await db.col.lease.findOne({ _id: "engine" })).toMatchObject({ holder: "engine-a:1" })

    // A second engine waits for the lease; here it gives up when its shutdown signal fires.
    const second = new Lease(db.col, "engine-b:1", silentLogger)
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 50)
    await second.acquire(stop.signal)
    expect(await db.col.lease.findOne({ _id: "engine" })).toMatchObject({ holder: "engine-a:1" })

    await first.release()
    await second.acquire()
    expect(await db.col.lease.findOne({ _id: "engine" })).toMatchObject({ holder: "engine-b:1" })
    await second.release()
  })
})
