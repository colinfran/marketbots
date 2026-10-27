"use client"

import { Alert, AlertDescription, AlertTitle } from "@mb/ui/components/alert"
import { Button } from "@mb/ui/components/button"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Something went wrong loading this page</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{error.message || "Unknown error"}</p>
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}
