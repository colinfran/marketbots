"use client"

import { LoaderIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "./components/button"

/** Lifts one rate-limit ban (DELETE /api/bans, owner only), then refreshes the list. */
export function UnbanButton({ address }: { address: string }) {
  const router = useRouter()
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const unban = async () => {
    setState({ busy: true, error: null })
    const res = await fetch("/api/bans", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }).catch(() => null)
    const body = (res ? await res.json().catch(() => ({})) : {}) as { error?: string }
    if (!res?.ok) {
      setState({ busy: false, error: body.error ?? "Request failed" })
      return
    }
    setState({ busy: false, error: null })
    router.refresh()
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="xs" disabled={state.busy} onClick={() => void unban()}>
        {state.busy && <LoaderIcon className="animate-spin" aria-hidden />}
        Unban
      </Button>
      {state.error && <p className="text-loss text-xs">{state.error}</p>}
    </div>
  )
}
