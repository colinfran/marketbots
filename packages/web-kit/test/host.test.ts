import { describe, expect, it, vi } from "vitest"
import { createHost } from "../src/host"

// Outside a request, Next's connection() has nothing to wait for.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }))

const SECRET = "s".repeat(40)
const env = (url: string | null = "https://engine.example.app/host/") => ({ hostApiUrl: () => url, hostApiSecret: () => SECRET })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** createHost on a fake fetch that answers with `answer`, recording each call. */
const setup = (answer: (init: RequestInit) => Response | Promise<Response>, e = env()) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return answer(init)
  }) as typeof fetch
  const audit = { insertOne: vi.fn(async () => ({})) }
  return { host: createHost({ env: e, audit: async () => audit as never, fetchFn }), calls, audit }
}

describe("createHost", () => {
  it("calls the agent's API with the secret and no caching, and reads nothing when it can't be reached", async () => {
    const { host, calls } = setup(() => json({ _id: "current", at: "2026-10-31T12:00:00.000Z" }))
    expect(await host.getHostStatus()).toEqual({ _id: "current", at: "2026-10-31T12:00:00.000Z" })
    expect(calls[0].url).toBe("https://engine.example.app/host/status")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${SECRET}`)
    expect(calls[0].init.cache).toBe("no-store")
    const down = setup(() => Promise.reject(new Error("connect ECONNREFUSED")))
    expect(await down.host.getHostStatus()).toBeNull()
    expect(await down.host.getHostHistory("1h")).toBeNull()
    expect(await down.host.getHostCommand("c1")).toBeNull()
    const unset = setup(() => json({}), env(null))
    expect(await unset.host.getHostStatus()).toBeNull()
    expect(unset.calls).toEqual([])
  })

  it("sends a valid command with its id and actor, then audits the request", async () => {
    const { host, calls, audit } = setup((init) => json({ id: (JSON.parse(String(init.body)) as { id: string }).id }, 202))
    const result = await host.submitHostCommand({ type: "fans.set", mode: "manual", manual_pct: 70 }, "owner")
    const sent = JSON.parse(String(calls[0].init.body)) as { id: string; actor: string; command: unknown }
    expect(result).toEqual({ ok: true, id: sent.id })
    expect([calls[0].url, calls[0].init.method, sent]).toEqual(["https://engine.example.app/host/commands", "POST", { id: sent.id, actor: "owner", command: { type: "fans.set", mode: "manual", manual_pct: 70 } }])
    expect(audit.insertOne).toHaveBeenCalledWith(expect.objectContaining({ actor: "owner", action: "host_command.requested", target: sent.id, details: { type: "fans.set", command: sent.command } }))
  })

  it("refuses an invalid command without calling the agent, and audits nothing the agent didn't take", async () => {
    const { host, calls, audit } = setup(() => json({ error: "a command with this id exists" }, 409))
    expect(await host.submitHostCommand({ type: "fans.set", mode: "manual", manual_pct: 10 }, "owner")).toMatchObject({ ok: false, error: expect.stringMatching(/manual_pct/) })
    expect(calls).toEqual([])
    expect(await host.submitHostCommand({ type: "outlets.discover" }, "owner")).toEqual({ ok: false, error: "The server's host agent didn't take it: a command with this id exists" })
    const down = setup(() => Promise.reject(new Error("The operation was aborted due to timeout")))
    expect(await down.host.submitHostCommand({ type: "outlets.discover" }, "owner")).toEqual({ ok: false, error: "The server's host agent didn't take it: The operation was aborted due to timeout" })
    expect(audit.insertOne).not.toHaveBeenCalled()
    expect(down.audit.insertOne).not.toHaveBeenCalled()
  })
})
