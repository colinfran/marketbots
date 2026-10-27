import { authRoute } from "@mb/web-kit/auth"
import { auth, authConfigured } from "@/lib/auth"

// Better Auth: magic-link sign-in, link verification, sign-out (see lib/auth.ts).
export const { GET, POST } = authRoute({ auth, authConfigured })
