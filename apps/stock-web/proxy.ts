import { rateLimitProxy } from "@mb/web-kit/rate-limit"
import { isOwnerRequest } from "@/lib/auth"

/** Per-visitor rate limit and automatic bans (@mb/web-kit/rate-limit; docs/SERVER.md §8.6). */
export const proxy = rateLimitProxy({ isOwner: isOwnerRequest })

export const config = {
  // Everything but build assets and static files, which Next serves from disk. robots.txt is also
  // the container's healthcheck.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.webmanifest|icon|apple-icon).*)"],
}
