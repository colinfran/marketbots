import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { DEFAULT_HOST_SETTINGS, type HostCommand, type HostStatusDoc } from "@mb/core/host"
import { afterEach, describe, expect, it } from "vitest"
import { createApi } from "../src/api"
import { HostStore } from "../src/store"

const SECRET = "s".repeat(40)
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** The API on a free local port, with a store and a command queue that only records what it took. */
const setup = async () => {
  const store = new HostStore(":memory:")
  const taken: { id: string; command: HostCommand; actor: string }[] = []
  const submit = (id: string, command: HostCommand, actor: string) => {
    taken.push({ id, command, actor })
    return store.addCommand({ _id: id, type: command.type, command, status: "pending", created_at: new Date(NOW), created_by: actor, processed_at: null, result: null, error: null })
  }
  const server = createApi({ secret: SECRET, store, commands: { submit }, log: quiet, now: () => NOW })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (path: string, init: RequestInit = {}, secret: string | null = SECRET) =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) } })
  const post = (body: unknown) => call("/commands", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  return { store, taken, call, post }
}

describe("the agent's API", () => {
  it("answers nothing without the shared secret", async () => {
    const { call } = await setup()
    expect((await call("/status", {}, null)).status).toBe(401)
    expect((await call("/status", {}, "s".repeat(39) + "x")).status).toBe(401)
    expect((await call("/status", {}, "short")).status).toBe(401)
    expect((await call("/status")).status).toBe(200)
  })

  it("serves the latest reading, with its dates as ISO strings, and a range's chart points", async () => {
    const { store, call } = await setup()
    expect(await (await call("/status")).json()).toBeNull()
    store.write({ _id: "current", at: new Date(NOW), settings: DEFAULT_HOST_SETTINGS } as unknown as HostStatusDoc, [])
    const res = await call("/status")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ _id: "current", at: new Date(NOW).toISOString(), settings: DEFAULT_HOST_SETTINGS })
    expect(await (await call("/history?range=24h")).json()).toEqual({ range: "24h", points: [], gpus: [] })
    expect((await call("/history?range=1y")).status).toBe(400)
    expect((await call("/nothing")).status).toBe(404)
  })

  it("takes a valid command and reports it until it is answered", async () => {
    const { store, taken, call, post } = await setup()
    const res = await post({ id: "c-1", actor: "owner", command: { type: "fans.set", mode: "manual", manual_pct: 70 } })
    expect([res.status, await res.json()]).toEqual([202, { id: "c-1" }])
    expect(taken).toEqual([{ id: "c-1", actor: "owner", command: { type: "fans.set", mode: "manual", manual_pct: 70 } }])
    expect(await (await call("/commands/c-1")).json()).toEqual({ _id: "c-1", type: "fans.set", status: "pending", result: null, error: null })
    store.setCommand("c-1", "done", "Manual speed 70% is set on 3 fans.", null)
    expect(await (await call("/commands/c-1")).json()).toMatchObject({ status: "done", result: "Manual speed 70% is set on 3 fans." })
    expect((await call("/commands/missing")).status).toBe(404)
  })

  it("refuses an invalid command, a taken id, a body that isn't JSON and one too large", async () => {
    const { taken, post } = await setup()
    const invalid = await post({ id: "c-1", actor: "owner", command: { type: "fans.set", mode: "manual", manual_pct: 10 } })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as { error: string }).error).toMatch(/manual_pct/)
    expect((await post({ id: "../x", actor: "owner", command: { type: "outlets.discover" } })).status).toBe(400)
    expect((await post({ id: "c-2", actor: "owner", command: { type: "outlets.discover" } })).status).toBe(202)
    expect((await post({ id: "c-2", actor: "owner", command: { type: "outlets.discover" } })).status).toBe(409)
    expect((await post("{not json")).status).toBe(400)
    expect((await post({ id: "c-3", actor: "owner", command: { type: "outlets.discover" }, pad: "x".repeat(20_000) })).status).toBe(413)
    // Only the valid ones reached the queue (the second c-2 is the one it refused).
    expect(taken.map((t) => t.id)).toEqual(["c-2", "c-2"])
  })
})
