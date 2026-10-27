"use client"

import type { Command } from "@mb/stock-core/commands"
import { LoaderIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Sends an owner command and waits for the engine to process it (it polls MongoDB every
 * second, so the result usually arrives within a couple of seconds). Shows the outcome inline.
 */
export const useCommand = () => {
  const router = useRouter()
  const [state, setState] = useState<{ busy: boolean; result: string | null; error: string | null }>({ busy: false, result: null, error: null })
  const send = async (command: Command): Promise<boolean> => {
    setState({ busy: true, result: null, error: null })
    const res = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }).catch(() => null)
    const body = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) {
      setState({ busy: false, result: null, error: body.error ?? "Request failed" })
      return false
    }
    // Wait for the engine (up to ~30s); if it's offline the command stays queued.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      const s = await fetch(`/api/commands/${body.id}`, { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null)
      if (s && (s.status === "done" || s.status === "failed" || s.status === "rejected")) {
        const ok = s.status === "done"
        setState({ busy: false, result: ok ? s.result : null, error: ok ? null : s.error })
        router.refresh()
        return ok
      }
    }
    setState({ busy: false, result: null, error: "Queued, but the engine hasn't processed it yet (is it running?)." })
    return false
  }
  return { ...state, send }
}

export function CommandResult({ result, error }: { result: string | null; error: string | null }) {
  if (!result && !error) return null
  return <p className={cn("text-xs", error ? "text-loss" : "text-muted-foreground")}>{error ?? result}</p>
}

/** A button that sends one command, optionally behind a confirmation dialog (and typed phrase). */
export function CommandButton({
  command,
  label,
  variant = "outline",
  size = "sm",
  confirm,
  disabled,
}: {
  command: Command
  label: React.ReactNode
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  confirm?: { title: string; description: string; phrase?: string; action?: string }
  disabled?: boolean
}) {
  const { busy, result, error, send } = useCommand()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const button = (
    <Button variant={variant} size={size} disabled={busy || disabled} onClick={confirm ? undefined : () => void send(command)}>
      {busy && <LoaderIcon className="animate-spin" aria-hidden />}
      {label}
    </Button>
  )
  return (
    <div className="flex flex-col items-start gap-1">
      {confirm ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>{button}</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
              <DialogDescription>{confirm.description}</DialogDescription>
            </DialogHeader>
            {confirm.phrase && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-phrase">
                  Type <span className="font-mono font-semibold">{confirm.phrase}</span> to confirm
                </Label>
                <Input id="confirm-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant={variant === "destructive" ? "destructive" : "default"}
                disabled={busy || (!!confirm.phrase && typed !== confirm.phrase)}
                onClick={async () => {
                  setOpen(false)
                  setTyped("")
                  await send(command)
                }}
              >
                {confirm.action ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        button
      )}
      <CommandResult result={result} error={error} />
    </div>
  )
}
