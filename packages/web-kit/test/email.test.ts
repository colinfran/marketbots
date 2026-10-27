import { afterEach, describe, expect, it, vi } from "vitest"
import { email } from "../src/email"
import type { DashboardEnv } from "../src/env"

const env = { usesendApiKey: () => "key", usesendBaseUrl: () => "https://mail.example/", usesendFrom: () => "Bot <no-reply@example.com>" } as unknown as DashboardEnv

const sent = () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetch)
  return () => {
    const [url, init] = fetch.mock.calls[0]
    return { url, body: JSON.parse(String(init.body)) as { from: string; to: string; subject: string; text: string; html: string } }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("sign-in code email", () => {
  it("puts the code in the subject, so the notification alone is enough", async () => {
    const message = sent()
    await email({ appName: "TestBot", env }).sendSignInCodeEmail({ to: "owner@example.com", code: "042137", minutes: 5 })
    const { url, body } = message()
    expect(url).toBe("https://mail.example/api/v1/emails")
    expect(body.to).toBe("owner@example.com")
    expect(body.from).toBe("Bot <no-reply@example.com>")
    expect(body.subject).toBe("042137 is your TestBot sign-in code")
    expect(body.text).toContain("042137")
    expect(body.text).toContain("5 minutes")
    expect(body.html).toContain("042137")
    expect(body.html).not.toContain("href")
  })
})
