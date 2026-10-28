"use client"

import { LoaderIcon, MailCheckIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "./components/button"
import { Input } from "./components/input"
import { Label } from "./components/label"
import { authClient } from "./lib/auth-client"
import { useInstalledApp } from "./lib/installed-app"

const codeError = (error: { code?: string; message?: string } | null | undefined) => {
  switch (error?.code) {
    case "INVALID_OTP":
      return "That code is wrong or no longer valid. Check the latest email."
    case "OTP_EXPIRED":
      return "That code expired. Start over for a new one."
    case "TOO_MANY_ATTEMPTS":
      return "Too many wrong codes. Start over for a new one."
    default:
      return error?.message ?? "Couldn't sign in"
  }
}

export function LoginForm({ linkError }: { linkError: string | null }) {
  // The Home Screen app keeps its own cookies, apart from the browser's: an emailed link opens in
  // the browser and signs that in, not the app. So the app asks for a code.
  const app = useInstalledApp()
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(linkError)
  const [busy, setBusy] = useState(false)
  const startOver = () => {
    setSent(false)
    setCode("")
    setError(null)
  }
  if (sent && !app) {
    return (
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border p-4 text-sm">
          <MailCheckIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <p>If {email} is the owner&apos;s address, a sign-in link is on its way. It works once and expires in 5 minutes.</p>
        </div>
        <Button variant="outline" className="w-full" onClick={startOver}>
          Use a different email
        </Button>
      </div>
    )
  }
  if (sent) {
    return (
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          const res = await authClient.signIn.emailOtp({ email, otp: code }).catch(() => null)
          if (res && !res.error) {
            // The refresh re-renders the shared layout too (the header's owner links).
            router.replace("/admin")
            router.refresh()
            return
          }
          setBusy(false)
          setError(codeError(res?.error))
        }}
      >
        <div className="flex gap-3 rounded-lg border p-4 text-sm">
          <MailCheckIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <p>If {email} is the owner&apos;s address, a 6-digit code is on its way. It works once and expires in 5 minutes.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
          />
        </div>
        {error && <p className="text-loss text-sm">{error}</p>}
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
          {busy && <LoaderIcon className="animate-spin" aria-hidden />}
          Sign in
        </Button>
        <Button type="button" variant="outline" className="w-full" onClick={startOver}>
          Start over
        </Button>
      </form>
    )
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        const res = app
          ? await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }).catch(() => null)
          : await authClient.signIn.magicLink({ email, callbackURL: "/admin", errorCallbackURL: "/login" }).catch(() => null)
        setBusy(false)
        if (res && !res.error) setSent(true)
        else setError(res?.error?.message ?? `Couldn't send the sign-in ${app ? "code" : "link"}`)
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      {error && <p className="text-loss text-sm">{error}</p>}
      <Button type="submit" disabled={busy || !email} className="w-full">
        {busy && <LoaderIcon className="animate-spin" aria-hidden />}
        Email me a sign-in {app ? "code" : "link"}
      </Button>
    </form>
  )
}
