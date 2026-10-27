import { vi } from "vitest"

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })

export const text = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init })

type Reply = Response | Error | ((url: URL, init: RequestInit) => Response | Promise<Response>)

/**
 * Replaces global fetch with a queue of canned replies (a Response, an Error to throw as a network
 * failure, or a function of the request). Calls past the end of the queue fail the test.
 */
export const mockFetch = (...replies: Reply[]) => {
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const reply = replies.shift()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!reply) throw new Error(`Unexpected extra fetch: ${init.method ?? "GET"} ${url}`)
    if (reply instanceof Error) throw reply
    return typeof reply === "function" ? reply(url, init) : reply
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

/** The URL and options of the n-th fetch call. */
export const fetchCall = (fn: ReturnType<typeof mockFetch>, n = 0) => {
  const [input, init] = fn.mock.calls[n]
  return { url: new URL(String(input)), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined }
}
