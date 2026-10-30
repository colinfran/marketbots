import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { azureMonitorConfig, azureStorage, resetAzureTokenCache } from "../src/azure"

const CFG = { tenantId: "tenant", clientId: "client", clientSecret: "secret", resourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DocumentDB/mongoClusters/c" }
const NOW = Date.parse("2026-10-30T22:05:00Z")

const metrics = (used: (number | undefined)[], percent: (number | undefined)[]) => ({
  value: [
    { name: { value: "StorageUsed" }, timeseries: [{ data: used.map((maximum, i) => ({ timeStamp: `2026-10-30T22:0${i}:00Z`, maximum })) }] },
    { name: { value: "StoragePercent" }, timeseries: [{ data: percent.map((maximum, i) => ({ timeStamp: `2026-10-30T22:0${i}:00Z`, maximum })) }] },
  ],
})

/** Answers the token request, then the metrics request, recording each call. */
const azure = (body: unknown, { tokenStatus = 200, metricsStatus = 200 } = {}) => {
  const fetch = vi.fn(async (url: string) =>
    url.includes("login.microsoftonline.com")
      ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: tokenStatus })
      : new Response(JSON.stringify(body), { status: metricsStatus }),
  )
  vi.stubGlobal("fetch", fetch)
  return fetch
}

beforeEach(() => resetAzureTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe("azureMonitorConfig", () => {
  const env = (values: Record<string, string | null>) => ({
    azureTenantId: () => values.tenant,
    azureClientId: () => values.client,
    azureClientSecret: () => values.secret,
    azureDocumentDbResourceId: () => values.resource,
  })

  it("needs all four variables", () => {
    expect(azureMonitorConfig(env({ tenant: "t", client: "c", secret: "s", resource: "/r" }))).toEqual({ tenantId: "t", clientId: "c", clientSecret: "s", resourceId: "/r" })
    expect(azureMonitorConfig(env({ tenant: "t", client: "c", secret: null, resource: "/r" }))).toBeNull()
  })
})

describe("azureStorage", () => {
  it("takes the latest minute Azure has, and the disk from used ÷ percent", async () => {
    const fetch = azure(metrics([4_900_000_000, 4_958_121_984, undefined], [14.6, 14.8, undefined]))
    expect(await azureStorage(CFG, NOW)).toEqual({ used_bytes: 4_958_121_984, limit_bytes: 33_500_824_216, percent: 14.8, at: new Date("2026-10-30T22:01:00Z") })
    const url = String(fetch.mock.calls[1][0])
    expect(url.startsWith(`https://management.azure.com${CFG.resourceId}/providers/Microsoft.Insights/metrics?`)).toBe(true)
    expect(new URL(url).searchParams.get("metricnames")).toBe("StorageUsed,StoragePercent")
  })

  it("signs in once per hour, not per page load", async () => {
    const fetch = azure(metrics([1], [1]))
    await azureStorage(CFG, NOW)
    await azureStorage(CFG, NOW)
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("login.microsoftonline.com"))).toHaveLength(1)
  })

  it("explains a refused sign-in or query", async () => {
    azure({}, { tokenStatus: 401 })
    await expect(azureStorage(CFG, NOW)).rejects.toThrow("Azure sign-in failed (HTTP 401)")
    azure({}, { metricsStatus: 403 })
    await expect(azureStorage(CFG, NOW)).rejects.toThrow("Azure Monitor failed (HTTP 403)")
  })

  it("reports missing figures instead of inventing them", async () => {
    azure(metrics([undefined], [undefined]))
    await expect(azureStorage(CFG, NOW)).rejects.toThrow("no storage figures")
  })
})
