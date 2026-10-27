"use client"

import { LoaderIcon, MailCheckIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "./components/button"
import { Input } from "./components/input"
import { Label } from "./components/label"
import { authClient } from "./lib/auth-client"

export function LoginForm({ linkError }: { linkError: string | null }) {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(linkError)
  const [busy, setBusy] = useState(false)
  if (sent) {
    return (
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border p-4 text-sm">
          <MailCheckIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <p>If {email} is the owner&apos;s address, a sign-in link is on its way. It works once and expires in 5 minutes.</p>
        </div>
        <Button variant="outline" className="w-full" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </div>
    )
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        const res = await authClient.signIn.magicLink({ email, callbackURL: "/admin", errorCallbackURL: "/login" }).catch(() => null)
        setBusy(false)
        if (res && !res.error) setSent(true)
        else setError(res?.error?.message ?? "Couldn't send the sign-in link")
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      {error && <p className="text-loss text-sm">{error}</p>}
      <Button type="submit" disabled={busy || !email} className="w-full">
        {busy && <LoaderIcon className="animate-spin" aria-hidden />}
        Email me a sign-in link
      </Button>
    </form>
  )
}
