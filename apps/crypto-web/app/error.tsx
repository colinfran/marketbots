"use client"

import { Button } from "@/components/ui/button"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong loading this page</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {/MONGODB_URI|ECONNREFUSED|Server selection/i.test(error.message) ? "The database is unreachable. Check MONGODB_URI and Atlas network access." : "The error was logged."}
        {error.digest && <span className="block font-mono text-xs">ref {error.digest}</span>}
      </p>
      <Button className="mt-4" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
