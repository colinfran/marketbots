import Link from "next/link"

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted-foreground mt-2 text-sm">That page, episode or decision doesn&apos;t exist (old records expire).</p>
      <Link prefetch href="/" className="mt-4 inline-block text-sm font-medium hover:underline">
        Back to the overview
      </Link>
    </div>
  )
}
