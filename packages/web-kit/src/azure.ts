import "server-only"

/**
 * Azure Monitor's view of the database cluster: its storage as Azure counts it (data, indexes, logs
 * and system files), which is what fills the disk. Read with a service principal that only has
 * Monitoring Reader on the cluster (docs/SERVER.md §1); without its four variables nothing is read.
 */

export type AzureMonitorConfig = { tenantId: string; clientId: string; clientSecret: string; resourceId: string }

/** The four AZURE_* values, or null unless every one is set. */
export const azureMonitorConfig = (env: {
  azureTenantId: () => string | null
  azureClientId: () => string | null
  azureClientSecret: () => string | null
  azureDocumentDbResourceId: () => string | null
}): AzureMonitorConfig | null => {
  const [tenantId, clientId, clientSecret, resourceId] = [env.azureTenantId(), env.azureClientId(), env.azureClientSecret(), env.azureDocumentDbResourceId()]
  return tenantId && clientId && clientSecret && resourceId ? { tenantId, clientId, clientSecret, resourceId } : null
}

const TIMEOUT_MS = 8_000
const WINDOW_MS = 30 * 60_000

/** One token per serverless instance, reused until a minute before it expires (an hour). */
let cached: { clientId: string; token: string; expiresAt: number } | null = null

const accessToken = async (cfg: AzureMonitorConfig) => {
  if (cached && cached.clientId === cfg.clientId && cached.expiresAt - 60_000 > Date.now()) return cached.token
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "https://management.azure.com/.default" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Azure sign-in failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { access_token: string; expires_in: number }
  cached = { clientId: cfg.clientId, token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  return body.access_token
}

type MetricsResponse = { value: { name: { value: string }; timeseries: { data: { timeStamp: string; maximum?: number }[] }[] }[] }

/** The latest minute of a metric, from the last 30 minutes (Azure publishes them a minute or two late). */
const latest = (body: MetricsResponse, name: string) => {
  const points = body.value.find((m) => m.name.value === name)?.timeseries[0]?.data ?? []
  for (let i = points.length - 1; i >= 0; i--) if (typeof points[i].maximum === "number") return { value: points[i].maximum!, at: new Date(points[i].timeStamp) }
  return null
}

/** Storage used and the disk it fills (from StorageUsed and StoragePercent), as of the latest minute Azure has. */
export const azureStorage = async (cfg: AzureMonitorConfig, now = Date.now()) => {
  const token = await accessToken(cfg)
  const query = new URLSearchParams({
    "api-version": "2018-01-01",
    metricnames: "StorageUsed,StoragePercent",
    aggregation: "Maximum",
    interval: "PT1M",
    timespan: `${new Date(now - WINDOW_MS).toISOString()}/${new Date(now).toISOString()}`,
  })
  const res = await fetch(`https://management.azure.com${cfg.resourceId}/providers/Microsoft.Insights/metrics?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Azure Monitor failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as MetricsResponse
  const used = latest(body, "StorageUsed")
  const percent = latest(body, "StoragePercent")
  if (!used || !percent || percent.value <= 0) throw new Error("Azure Monitor has no storage figures for the last 30 minutes")
  return { used_bytes: used.value, limit_bytes: Math.round((used.value * 100) / percent.value), percent: percent.value, at: used.at }
}

/** For tests: forget the cached token. */
export const resetAzureTokenCache = () => {
  cached = null
}
