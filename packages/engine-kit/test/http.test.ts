import { describe, expect, it } from "vitest"
import { HttpError, httpClient } from "../src/util/http"
import { fetchCall, mockFetch, text } from "../src/testing/fetch"

const { requestText } = httpClient("TestBot/0.1 (+https://example.com)")

describe("httpClient", () => {
  it("sends the engine's User-Agent unless the caller sets its own", async () => {
    const fetch = mockFetch(text("a"), text("b"))
    await requestText("https://api.example.com/a")
    await requestText("https://api.example.com/b", { headers: { "User-Agent": "Name contact@example.com" } })
    expect(fetchCall(fetch, 0).init.headers).toEqual({ "user-agent": "TestBot/0.1 (+https://example.com)" })
    expect(fetchCall(fetch, 1).init.headers).toEqual({ "User-Agent": "Name contact@example.com" })
  })

  it("throws an HttpError with the body for a non-retryable status", async () => {
    mockFetch(text("nope", { status: 404 }))
    await expect(requestText("https://api.example.com/missing")).rejects.toBeInstanceOf(HttpError)
  })
})
