import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { LoginForm } from "./login-form"
import { getViewer } from "@/lib/auth"

export const metadata: Metadata = { title: "Owner sign in", robots: { index: false, follow: false } }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if ((await getViewer()).owner) redirect("/admin")
  // Better Auth sends failed magic links back here with ?error=<code>.
  const { error } = await searchParams
  return (
    <div className="mx-auto max-w-sm py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Owner sign in</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">The dashboard is public and read-only. Signing in unlocks the controls: pause, kill switch, settings and position management.</p>
      <LoginForm linkError={error ? "That sign-in link is invalid, already used or expired. Request a new one." : null} />
    </div>
  )
}
