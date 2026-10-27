import { magicLinkClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/** Browser half of owner sign-in (the server half is lib/auth.ts). Same origin, so no baseURL. */
export const authClient = createAuthClient({ plugins: [magicLinkClient()] })
