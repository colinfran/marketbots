import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { MARKET_TZ } from "@mb/stock-core/time"
import { HostDashboard } from "@mb/ui/host"
import { PageHeader } from "@/components/bits"
import { getViewer } from "@/lib/auth"
import { getHostStatus } from "@/lib/host"

export const metadata: Metadata = { title: "Server", robots: { index: false, follow: false } }

/** Admin → Server: the Windows machine both bots run on, from the host agent (docs/SERVER.md §11). */
export default async function ServerPage() {
  const viewer = await getViewer()
  if (!viewer.owner) redirect("/login")
  const status = await getHostStatus()
  return (
    <div className="space-y-2">
      <PageHeader
        title="Server"
        description="The Windows PC both bots run on, as the host agent reads it every few seconds: processor, graphics cards, memory, fans, disks and power at the outlet, with 30 days of history. The fan and agent settings apply to the whole machine, from either dashboard."
      />
      <HostDashboard initial={status} timeZone={MARKET_TZ} />
    </div>
  )
}
