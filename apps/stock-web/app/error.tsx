"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

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
